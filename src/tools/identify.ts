import { addressArg } from "./args.js";
import { describeError, errorResult, isNotFound } from "../utils/errors.js";
import { fetchActiveValidators, findValidatorByAddress } from "../utils/validators.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { getNetwork, suivisionPackageUrl } from "../config.js";
import { formatOwner } from "../utils/formatting.js";
import { isCuratedProtocol, lookupProtocolDisplay, prefetchProtocolCustody, prefetchProtocolNames } from "../protocols/registry.js";
import { notePackageRoot } from "../protocols/package-roots.js";
import { getPackageCustody } from "../protocols/package-custody.js";
import { aliasScanAsOfClause, describeAddresses, heldNamesNote, readFirstSeen, type AddressIdentity, type AliasSet } from "../utils/identity.js";
import { resolvePublisher } from "../utils/publisher.js";
import { formatCoinAmount } from "../utils/coin-amount.js";
import { objectAddressBalanceFields } from "../utils/address-balance.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getLabel, isSinkCategory, labelProvenance } from "../utils/labels.js";
import { guardiansFlagsForObjectType, guardiansFlagsForPackage, type GuardiansFlag } from "../utils/guardians.js";
import { baseType } from "../utils/object-flow.js";
import { KIOSK_TYPE, resolveKioskCapHolder, unresolvedCapHolderNote } from "../utils/kiosk.js";
import { bridgeExitCalls, fetchModuleBytes } from "../utils/bridge/carrier.js";
import { bridgeLabeledObjectsOf } from "../utils/bridge/labeled-package.js";

/**
 * The address's label with its provenance, spread into every case's result.
 * The recommended first step is where an investigator learns that an address
 * is a Binance reserve wallet or a named exploiter, and on what evidence.
 */
function labelFields(address: string) {
  const found = getLabel(address);
  if (!found) return {};
  return {
    label: {
      label: found.label,
      category: found.category,
      source: found.source,
      is_sink: isSinkCategory(found.category),
      ...labelProvenance(found),
      ...(found.notes ? { notes: found.notes } : {}),
    },
  };
}

const flaggedFields = (flags: GuardiansFlag[]) => (flags.length > 0 ? { flagged_by: flags } : {});

const LATEST_VERSION_QUERY = `query ($addr: SuiAddress!) {
  packageVersions(address: $addr, last: 1) { nodes { address version } }
}`;

interface PackageLineage {
  root_package_id: string | null;
  version: number | null;
  latest_version: number | null;
  latest_package_id: string | null;
  is_latest: boolean | null;
}

/**
 * Where this package sits in its upgrade lineage.
 *
 * Worth its own round trip: "is the ID I was handed the current one" decides
 * whether an investigation is looking at live code or at a version the protocol
 * moved off, and the answer is invisible from the ID alone. The root arrives
 * free with the package itself (gRPC returns `originalId` alongside the
 * modules), so only the newest version costs a query — and failing that query
 * degrades the answer rather than the tool.
 */
async function describeLineage(
  address: string,
  originalId: string | undefined,
  version: bigint | undefined,
): Promise<PackageLineage> {
  const lineage: PackageLineage = {
    root_package_id: originalId ?? null,
    version: version !== undefined ? Number(version) : null,
    latest_version: null,
    latest_package_id: null,
    is_latest: null,
  };

  // Seed the registry's lineage cache with the root we were just given, so
  // protocol identification below needs no lookup of its own.
  if (originalId) notePackageRoot(address, originalId);

  try {
    const r = await gqlQuery<{
      packageVersions: { nodes: Array<{ address: string; version: number }> } | null;
    }>(LATEST_VERSION_QUERY, { addr: address });
    const latest = r.packageVersions?.nodes?.[0];
    if (latest) {
      lineage.latest_version = latest.version;
      lineage.latest_package_id = latest.address;
      if (lineage.version !== null) lineage.is_latest = latest.version === lineage.version;
    }
  } catch {
    // Lineage detail is an enrichment; the module list is the actual answer.
  }

  return lineage;
}

interface ValidatorMatch {
  name: string;
  staking_pool_sui_balance: string | null;
  commission_rate_bps: number | null;
}

async function findValidator(address: string): Promise<ValidatorMatch | null> {
  try {
    const set = await fetchActiveValidators();
    const match = findValidatorByAddress(set, address);
    if (!match) return null;
    const json = match.contents!.json;
    return {
      name: json.metadata?.name ?? "Unknown",
      staking_pool_sui_balance: json.staking_pool?.sui_balance ?? null,
      commission_rate_bps: json.commission_rate != null ? Number(json.commission_rate) : null,
    };
  } catch {
    // A failed lookup is not evidence the address is not a validator; it just
    // means we could not tell. Returning null lets classification continue,
    // which is why the caller must not present "wallet" as confirmed.
    return null;
  }
}

/**
 * What a committee wallet's alias set means for the committee.
 *
 * A set holding only the owner widens nothing. A set the owner is absent from
 * is a total lockout, and calling that "not the only way" would understate the
 * loudest finding this tool produces.
 */
function aliasHint(aliases?: AliasSet): string {
  if (!aliases || aliases.delegated_to.length === 0) return "";
  return aliases.owner_can_authorize
    ? " It has also authorized aliases, so the committee is not the only way to move these funds."
    : " Its alias set does NOT include this address, so the committee can no longer authorize for it at all and only the addresses in delegated_to can move these funds.";
}

const BRIDGE_CARRIER_ROLE =
  "This package's bytecode calls a curated bridge's exit entry (calls), so it can send that bridge's transfer on a caller's behalf: a bridge adapter, aggregator or router. resolve_bridge_transfer on one of its transactions names it under carriers with the event it emitted.";

const BRIDGE_CARRIER_UNREAD =
  "The package's module bytes could not be read, so whether it calls a bridge's exit entry was not checked.";

export function registerIdentifyTools(server: McpServer) {
  server.tool(
    "identify_address",
    "(Recommended first step) Identify what a Sui address is: wallet, package, validator, or object. Returns a type classification with contextual summary (e.g. balance + SuiNS for wallets, module list for packages, stake info for validators). Use this before deciding which other tools to call. For a package, `protocol` falls back to the entity of a bridge label on an object whose type the package defines (`identified_via: labeled-object`), and `bridge_carrier` lists its bytecode's calls into a curated bridge's exit entry: an adapter or aggregator that can send that bridge's transfers. A wallet's `first_seen` is the oldest transaction the GraphQL service returns with it as sender or affected party (digest, timestamp, checkpoint, sender, the coins it `received`). It reads all balance-change pages of that transaction. `first_inflow` is true when the wallet gained coins in a transaction it did not send, including a system-created genesis allocation with `sender: null`; genesis does not identify a funding wallet. If no gain was found and the balance changes could not all be read, `first_inflow` is null; `first_seen_unavailable` says the first read failed. find_funding_sources names the funder when the first transaction is not funding.",
    {
      address: addressArg().describe("Sui address or object ID (0x...)"),
    },
    async ({ address }) => {
      // Try to get object at this address first.
      //
      // NOT_FOUND is the load-bearing answer here: it means there is genuinely
      // no object at this address, which is what makes the wallet
      // classification below correct. Any other failure — an outage, a
      // timeout, a malformed address — means we could not ask, and the reads
      // in CASE 4 also swallow their errors, so the tool would answer
      // `type: "wallet", sui_balance: "0"` for a package or a pool. This is
      // the recommended first step, so a wrong classification steers every
      // tool call after it.
      let objectRes;
      try {
        ({ response: objectRes } = await sui.ledgerService.getObject({
          objectId: address,
          readMask: {
            paths: [
              "object_id", "version", "object_type", "owner", "json",
            ],
          },
        }));
      } catch (err) {
        if (!isNotFound(err)) {
          return errorResult(
            `Could not determine what ${address} is: the object lookup failed (${(err as Error).message}). ` +
              "This is not evidence the address is a wallet — retry rather than treating the address as unclassified.",
          );
        }
        objectRes = null;
      }

      const obj = objectRes?.object;
      const objectType = obj?.objectType ?? "";

      // CASE 1: It's a Move package
      if (objectType === "package" || objectType.endsWith("::package::Package")) {
        let modules: string[] = [];
        let originalId: string | undefined;
        let version: bigint | undefined;
        try {
          const { response: pkgRes } = await sui.movePackageService.getPackage({
            packageId: address,
          });
          modules = pkgRes.package?.modules?.map((m) => m.name ?? "") ?? [];
          originalId = pkgRes.package?.originalId;
          version = pkgRes.package?.version;
        } catch { /* ignore */ }

        const lineage = await describeLineage(address, originalId, version);

        // Attribute the ROOT, not the version handed in. An upgrade's creating
        // transaction was sent by whoever held the UpgradeCap then, which is
        // the upgrader and a different claim from the original publisher.
        const publisher = await resolvePublisher(lineage.root_package_id ?? address);

        // Identification, cheapest tier first. The lineage root is already
        // cached by describeLineage, so a package belonging to a curated
        // protocol resolves without another call. Only a package no lineage
        // claims falls through to an MVR lookup, and only one with no MVR
        // name either is named after the curated protocol whose key
        // published this version.
        await prefetchProtocolNames([address]);
        await prefetchProtocolCustody([address]);
        const shown = lookupProtocolDisplay(address, { custody: true });
        const custody = shown?.source === "publisher" ? getPackageCustody(address) : null;
        const protocol = shown
          ? {
              name: shown.name,
              type: shown.type,
              // How much the name is worth: "registry" and "lineage" are curated
              // and carry a verified category; "publisher" ties the package to
              // a curated protocol by the key that deployed it, with no
              // category; "mvr" is a string its owner registered. Anyone
              // judging a package deserves to know which they got.
              identified_via: shown.source ?? (isCuratedProtocol(address) ? "registry" : "lineage"),
              ...(custody
                ? {
                    shared_address: custody.address,
                    shared_with_package: custody.shared_with,
                    identified_via_note: `This package version was published by ${custody.address}, which also published or upgraded ${custody.protocol}'s lineage ${custody.shared_with}. That ties it to whoever holds that key; the category is not known.`,
                  }
                : {}),
            }
          : null;
        // No curated name: a bridge label on an object whose type this
        // lineage defines names the operator.
        const labeledObjects = protocol
          ? []
          : await bridgeLabeledObjectsOf([address, ...(lineage.root_package_id ? [lineage.root_package_id] : []), ...(originalId ? [originalId] : [])]);
        const named = protocol ?? (labeledObjects.length
          ? { name: labeledObjects[0].entity ?? labeledObjects[0].label, type: "bridge", identified_via: "labeled-object", labeled_objects: labeledObjects }
          : null);

        // Calls into a curated bridge's exit entry, read from the bytecode.
        const moduleBytes = await fetchModuleBytes(address);
        const exits = moduleBytes ? await bridgeExitCalls(moduleBytes) : null;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              address,
              type: "package",
              ...labelFields(address),
              ...flaggedFields(guardiansFlagsForPackage(address)),
              protocol: named,
              ...(exits?.calls.length
                ? { bridge_carrier: { evidence: "chain-derived", role: BRIDGE_CARRIER_ROLE, calls: exits.calls } }
                : {}),
              ...(exits?.unreadable.length ? { bridge_carrier_unreadable_modules: exits.unreadable } : {}),
              ...(!moduleBytes ? { bridge_carrier_check: BRIDGE_CARRIER_UNREAD } : {}),
              lineage,
              publisher,
              module_count: modules.length,
              modules: modules.slice(0, 20),
              modules_truncated: modules.length > 20,
              suivision_url: suivisionPackageUrl(address),
              hint:
                lineage.is_latest === false
                  ? `This is version ${lineage.version} of ${lineage.latest_version}; the current package is ${lineage.latest_package_id}. Older versions can still be live — use resolve_protocol_packages to see which versions emit events.`
                  : "Use get_package for module details and the dependency versions it runs, and disassemble_module (function_name for one function) to read the bytecode. decompile_module renders Move source when its optional binary is installed.",
            }),
          }],
        };
      }

      // CASE 2: It's some other on-chain object (shared, owned, etc.) but NOT an address
      // Heuristic: if the object has a complex type (not just "package"), it may be a shared object
      if (obj && objectType && !objectType.startsWith("0x2::coin::Coin")) {
        const owner = formatOwner(obj.owner);
        const isShared = owner?.startsWith("shared");
        // Funds an object holds in its own address balance are not among its
        // fields, so neither this answer nor get_object's content would show
        // them without asking. A bridge vault holding ~118k USDC this way read
        // as an ordinary shared object.
        const held = await objectAddressBalanceFields(address);
        const holdsFunds = Array.isArray(held.address_balances) && held.address_balances.length > 0;
        // `Kiosk.owner` above is a self-declared field. The framework does
        // not update it when the `KioskOwnerCap` that controls the kiosk is
        // transferred, so it can name a former owner. `kiosk_cap_holder`
        // names the cap's current holder.
        const kiosk =
          baseType(objectType) === KIOSK_TYPE
            ? await resolveKioskCapHolder(address).catch((err) => ({
                status: "lookup_failed" as const,
                message: describeError(err, getNetwork()),
              }))
            : null;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              address,
              type: isShared ? "shared_object" : "object",
              object_type: objectType,
              ...labelFields(address),
              ...flaggedFields(guardiansFlagsForObjectType(objectType)),
              owner,
              version: obj.version?.toString(),
              ...held,
              ...(kiosk
                ? {
                    kiosk_owner_field_caveat:
                      "The `owner` above is self-declared: it is set when the kiosk is created or by `set_owner`, and does not follow the KioskOwnerCap when the cap is transferred, so it can name a former owner. `kiosk_cap_holder` is who actually controls this kiosk, read from the cap's own current owner.",
                    ...(kiosk.status === "resolved"
                      ? {
                          kiosk_cap_holder: kiosk.result.holder,
                          kiosk_cap_id: kiosk.result.cap_id,
                          ...(kiosk.result.wrapped_in ? { kiosk_cap_wrapped_in: kiosk.result.wrapped_in } : {}),
                          ...(kiosk.result.holder ? {} : { kiosk_cap_holder_note: unresolvedCapHolderNote(kiosk.result) }),
                        }
                      : {
                          kiosk_cap_holder_note:
                            kiosk.status === "creation_unreachable"
                              ? "The kiosk's creation transaction could not be read, so its KioskOwnerCap could not be found."
                              : kiosk.status === "cap_not_found"
                                ? `No KioskOwnerCap naming this kiosk was found in its creation transaction (scanned ${kiosk.scanned_pages} page(s)${kiosk.truncated ? ", truncated before reaching the end" : ""}).`
                                : `The KioskOwnerCap lookup failed and was skipped: ${kiosk.message}`,
                        }),
                  }
                : {}),
              hint:
                (isShared
                  ? "This is a shared object (e.g. a pool, registry, or protocol state). Use get_object for its fields."
                  : "This is an owned object. Use get_object for its fields.") +
                (holdsFunds
                  ? " The funds under address_balances are held by the object itself and are not among those fields."
                  : ""),
            }),
          }],
        };
      }

      // CASE 3: Check if it's a validator
      const validator = await findValidator(address);
      if (validator) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              address,
              type: "validator",
              name: validator.name,
              staking_pool_sui_balance: validator.staking_pool_sui_balance,
              staking_pool_sui_balance_formatted: formatCoinAmount(validator.staking_pool_sui_balance, "0x2::sui::SUI"),
              commission_rate_bps: validator.commission_rate_bps,
              hint: `Use get_validators {"address": "${address}"} for full detail (credentials, staking stats, network addresses), or get_staking_summary for delegation positions.`,
            }),
          }],
        };
      }

      // CASE 4: Treat as a wallet address — fetch summary data in parallel
      const [balanceRes, nameRes, ownedRes, identities, firstSeenRes] = await Promise.all([
        // Each read reports its own failure: a failed balance read is not a
        // zero balance, and a failed name lookup is not the absence of a name.
        sui.getBalance({ owner: address }).catch((err: unknown) => ({ failed: describeError(err, getNetwork()) })),
        sui.nameService
          .reverseLookupName({ address })
          .then(({ response }) => response.record?.name ?? null)
          .catch((err: unknown) => (isNotFound(err) ? null : { failed: describeError(err, getNetwork()) })),
        sui.listBalances({ owner: address, limit: 10, cursor: null }).catch((err: unknown) => ({
          failed: describeError(err, getNetwork()),
        })),
        // Who can spend from it, and — if that is a committee — who those
        // members are. This is the tool that answers "what is this address",
        // so a multisig going unmentioned here is the omission that matters
        // most: nothing else in this response distinguishes a treasury
        // committee from one person's wallet.
        //
        // Aliases are asked for here and nowhere else in a flow, because they
        // answer the same question from the other side: since
        // `0x2::address_alias`, a committee being unable to rotate no longer
        // means the committee is the only way to move the funds.
        // A failed lookup must not render as "never sent a transaction".
        describeAddresses([address], { expandMembers: true, aliases: true, checkAliasSignatures: true }).catch(
          () =>
            new Map<string, AddressIdentity>([
              [address, { address, kind: "wallet", authentication_unavailable: true, aliases_unavailable: true }],
            ]),
        ),
        // How old the address is, so "is this address fresh" needs no
        // history call. A failed read is reported, never shown as no history.
        readFirstSeen(address).catch((err: unknown) => ({ failed: describeError(err, getNetwork()) })),
      ]);

      const balanceFailed = "failed" in balanceRes ? balanceRes.failed : null;
      const suiBalance = "failed" in balanceRes ? null : (balanceRes.balance?.balance ?? "0");
      const nameFailed = nameRes !== null && typeof nameRes === "object" ? nameRes.failed : null;
      const suiName = typeof nameRes === "string" ? nameRes : null;
      const tokensFailed = "failed" in ownedRes ? ownedRes.failed : null;
      const nonZeroTokens = "failed" in ownedRes ? null : (ownedRes.balances?.filter((b) => b.balance !== "0").length ?? 0);
      const auth = identities.get(address)?.authentication;
      const committee = identities.get(address)?.committee_members;
      const aliases = identities.get(address)?.aliases;
      const identity = identities.get(address);
      const firstSeenFailed = firstSeenRes !== null && "failed" in firstSeenRes ? firstSeenRes.failed : null;
      const firstSeen = firstSeenRes !== null && "failed" in firstSeenRes ? null : firstSeenRes;
      const namesNote = identity ? heldNamesNote(identity) : undefined;
      // Every caveat below that rests on the reverse alias scan says when that
      // (cached) scan was read.
      const aliasAsOf = identity?.alias_scan_as_of ? ` ${aliasScanAsOfClause(identity.alias_scan_as_of)}` : "";

      // No live object and no signature, yet a transaction recorded this id as
      // an object: the UID of something wrapped or deleted, such as a zkSend
      // bag. Calling it a wallet sends the reader looking for an owner's key.
      if (identity?.kind === "wrapped_or_deleted_object") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              address,
              type: "wrapped_or_deleted_object",
              object_seen_in: identity.object_seen_in,
              sui_balance: suiBalance,
              token_count: nonZeroTokens,
              meaning:
                "No live object is at this id and nothing has ever signed for it, but a transaction recorded it as an object id. It is the id of an object that was wrapped inside another object or deleted. Value sent to it is held by that object and leaves only through the module that owns it, in a transaction someone else sends.",
              hint: `Use get_transaction on ${identity.object_seen_in} to see which object this was, and trace_funds forward to follow value out of it.`,
            }),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            address,
            type: "wallet",
            ...labelFields(address),
            sui_name: suiName,
            ...(nameFailed
              ? { sui_name_unavailable: `The SuiNS reverse lookup failed (${nameFailed}), so whether this address has a name is unknown.` }
              : {}),
            // Stated at the point of use, not just in the tool description: a
            // name is the strongest pull toward off-chain identity this server
            // emits, and it is the least verified thing in the response.
            ...(suiName
              ? {
                  sui_name_caveat:
                    "Self-chosen, purchasable handle — not identity and not verified. Anyone may register a name resembling an exchange, project or person. Corroborate before treating it as attribution.",
                }
              : {}),
            sui_balance: suiBalance,
            sui_balance_formatted: formatCoinAmount(suiBalance, "0x2::sui::SUI"),
            ...(balanceFailed
              ? { sui_balance_unavailable: `The SUI balance read failed (${balanceFailed}), so the balance is unknown, not zero.` }
              : {}),
            token_count: nonZeroTokens,
            ...(tokensFailed
              ? { token_count_unavailable: `The balance list read failed (${tokensFailed}), so how many tokens this address holds is unknown.` }
              : {}),
            first_seen: firstSeen,
            ...(firstSeenFailed
              ? { first_seen_unavailable: `The earliest-transaction read failed (${firstSeenFailed}), so how old this address is is unknown.` }
              : firstSeen
                ? {}
                : { first_seen_note: "The GraphQL service returns no transaction with this address as sender or affected party." }),
            // Absent means this address has never SENT a transaction, so it
            // has produced no signature to read. That is not the same as an
            // ordinary single-key wallet, and the caveat says so rather than
            // letting the silence be read as one.
            authentication: auth ?? null,
            ...(auth
              ? identity?.signed_as_alias_for
                ? {
                    // A real scheme, but not read from a transaction this
                    // address sent: say where it came from so the reader does
                    // not mistake it for an ordinary sent-transaction match.
                    authentication_caveat: `This address has never sent a transaction of its own. The scheme above is read from ${identity.signed_as_alias_for.digest}, which its key signed as an address alias for ${identity.signed_as_alias_for.owner} (0x2::address_alias): a real signature, not a guess.${identity.alias_scan_unavailable ? " The reverse scan behind it did not fully complete (a request failed, or the on-chain scan was capped), so alias_delegate_for may be missing owners it did not reach." : ""}${aliasAsOf}`,
                  }
                : {}
              : {
                  // Only one of three readings is "never sent": the lookup can
                  // fail, and a sent transaction can be signed by someone else.
                  authentication_caveat: identity?.authentication_unavailable
                    ? "The lookup that reads this address's signatures failed, so how it authenticates, and whether it has sent anything, is unknown. Retry rather than reading this as a never-used address."
                    : identity?.foreign_authorization
                      ? `This address has sent transactions, but none of the ${identity.foreign_authorization.transactions_examined} examined carries its own signature: ${identity.foreign_authorization.digest} was authorized by ${identity.foreign_authorization.authorized_by.join(", ")}, acting for it through an address alias or a protocol-level substitution. How the address itself authenticates is unknown.`
                      : identity?.alias_scan_unavailable
                        ? `This address has never sent a transaction of its own, and the reverse scan that checks whether it signed as an address alias for someone else could not fully complete (a request failed, or the on-chain scan was capped). Whether it authenticates that way is unknown, not ruled out — retry rather than reading this as a fresh personal wallet.${aliasAsOf}`
                        : identity?.alias_delegate_for?.length
                          ? `This address has never sent a transaction of its own, but its key is named as a delegate in ${identity.alias_delegate_for.length === 1 ? "one owner's" : `${identity.alias_delegate_for.length} owners'`} 0x2::address_alias set (${identity.alias_delegate_for.join(", ")}); none of the sampled sent transactions of ${identity.alias_delegate_for.length === 1 ? "that owner" : "those owners"} carried its signature, which does not rule out an authorization that has simply never been used to sign.${aliasAsOf}`
                          : `This address has never sent a transaction, so how it authenticates is unknown. It may be a multisig, a zkLogin account or a single key — a receive-only treasury multisig is indistinguishable from a fresh personal wallet until it spends.${aliasAsOf}`,
                }),
            ...(identity?.foreign_authorization ? { foreign_authorization: identity.foreign_authorization } : {}),
            ...(identity?.signed_as_alias_for ? { signed_as_alias_for: identity.signed_as_alias_for } : {}),
            ...(identity?.alias_delegate_for?.length ? { alias_delegate_for: identity.alias_delegate_for } : {}),
            ...(identity?.alias_scan_as_of ? { alias_scan_as_of: identity.alias_scan_as_of } : {}),
            ...(committee ? { committee_members: committee } : {}),
            // Absent means no AddressAliases object exists. Most wallets have
            // never enabled the feature, so the field is omitted rather than
            // reported as an empty list.
            // Three readings, not two. A set holding only the owner is what
            // `enable` creates, so it is the absence of delegation; reporting
            // the owner as a party it authorized invents one.
            ...(aliases
              ? {
                  aliases: aliases.authorized,
                  owner_can_authorize: aliases.owner_can_authorize,
                  delegated_to: aliases.delegated_to,
                  aliases_note:
                    aliases.delegated_to.length === 0
                      ? "This wallet has enabled 0x2::address_alias and its set holds only its own address, so it has authorized nobody else. Nothing here widens who can move its funds. The set is mutable, so it is true as of now."
                      : aliases.owner_can_authorize
                        ? "The addresses in delegated_to have been authorized to act for this wallet through 0x2::address_alias, so each of them can move its funds, and the wallet's own key still can too. That is control read from chain state, and not evidence of shared ownership: a custodian holds authority for a client. The set is mutable, so it is true as of now."
                        : "The addresses in delegated_to have been authorized to act for this wallet through 0x2::address_alias, and the wallet's own address is NOT among them. An alias set replaces the signer rather than extending it, so this wallet's own key can no longer authorize for it and only those addresses can move its funds. The set is mutable, so it is true as of now.",
                }
              : {}),
            // A failed lookup is not an absence of delegation.
            ...(identities.get(address)?.aliases_unavailable
              ? {
                  aliases_unavailable:
                    "The alias set could not be read, so whether this wallet has authorized anyone else is unknown rather than settled.",
                }
              : {}),
            // Every registration it holds, with how each one arrived. A name
            // another address sent is reported so it is not read as the
            // holder's own.
            ...(identity?.names_held?.length ? { names_held: identity.names_held } : {}),
            ...(namesNote ? { names_note: namesNote } : {}),
            hint: auth?.scheme === "multisig"
              ? `This wallet is controlled by a committee. Each member listed in committee_members is a separate address with its own history — run identify_address or get_transaction_history on them, or pass them to build_wallet_edges as seeds.${aliasHint(aliases)}`
              : "Use get_wallet_overview for full portfolio, get_transaction_history for activity, or get_defi_positions for DeFi.",
          }),
        }],
      };
    }
  );
}
