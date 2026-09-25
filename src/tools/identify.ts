import { z } from "zod";
import { errorResult, isNotFound } from "../utils/errors.js";
import { fetchActiveValidators, findValidatorByAddress } from "../utils/validators.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { suivisionPackageUrl } from "../config.js";
import { formatOwner } from "../utils/formatting.js";
import { isCuratedProtocol, lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";
import { notePackageRoot } from "../protocols/package-roots.js";
import { describeAddresses, heldNamesNote, type AddressIdentity, type AliasSet } from "../utils/identity.js";
import { resolvePublisher } from "../utils/publisher.js";
import { objectAddressBalanceFields } from "../utils/address-balance.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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

export function registerIdentifyTools(server: McpServer) {
  server.tool(
    "identify_address",
    "(Recommended first step) Identify what a Sui address is: wallet, package, validator, or object. Returns a type classification with contextual summary (e.g. balance + SuiNS for wallets, module list for packages, stake info for validators). Use this before deciding which other tools to call.",
    {
      address: z.string().describe("Sui address or object ID (0x...)"),
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
        // protocol resolves without another call — and only a package no
        // lineage claims falls through to an MVR lookup.
        await prefetchProtocolNames([address]);
        const shown = lookupProtocolDisplay(address);
        const protocol = shown
          ? {
              name: shown.name,
              type: shown.type,
              // How much the name is worth: "registry" and "lineage" are curated
              // and carry a verified category; "mvr" is a string its owner
              // registered. Anyone judging a package deserves to know which of
              // the three they got.
              identified_via: shown.source === "mvr"
                ? "mvr"
                : isCuratedProtocol(address)
                  ? "registry"
                  : "lineage",
            }
          : null;

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              address,
              type: "package",
              protocol,
              lineage,
              publisher,
              module_count: modules.length,
              modules: modules.slice(0, 20),
              modules_truncated: modules.length > 20,
              suivision_url: suivisionPackageUrl(address),
              hint:
                lineage.is_latest === false
                  ? `This is version ${lineage.version} of ${lineage.latest_version}; the current package is ${lineage.latest_package_id}. Older versions can still be live — use resolve_protocol_packages to see which versions emit events.`
                  : "Use get_package for full module details, or decompile_module for source code.",
            }, null, 2),
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

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              address,
              type: isShared ? "shared_object" : "object",
              object_type: objectType,
              owner,
              version: obj.version?.toString(),
              ...held,
              hint:
                (isShared
                  ? "This is a shared object (e.g. a pool, registry, or protocol state). Use get_object for its fields."
                  : "This is an owned object. Use get_object for its fields.") +
                (holdsFunds
                  ? " The funds under address_balances are held by the object itself and are not among those fields."
                  : ""),
            }, null, 2),
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
              commission_rate_bps: validator.commission_rate_bps,
              hint: "Use get_validator_detail for full info, or get_staking_summary for delegation positions.",
            }, null, 2),
          }],
        };
      }

      // CASE 4: Treat as a wallet address — fetch summary data in parallel
      const [balanceRes, nameRes, ownedRes, identities] = await Promise.all([
        sui.getBalance({ owner: address }).catch(() => null),
        sui.nameService
          .reverseLookupName({ address })
          .then(({ response }) => response.record?.name ?? null)
          .catch(() => null),
        sui.listBalances({ owner: address, limit: 10, cursor: null }).catch(() => null),
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
        describeAddresses([address], { expandMembers: true, aliases: true }).catch(
          () => new Map<string, AddressIdentity>(),
        ),
      ]);

      const suiBalance = balanceRes?.balance?.balance ?? "0";
      const nonZeroTokens = ownedRes?.balances?.filter((b) => b.balance !== "0").length ?? 0;
      const auth = identities.get(address)?.authentication;
      const committee = identities.get(address)?.committee_members;
      const aliases = identities.get(address)?.aliases;
      const identity = identities.get(address);
      const namesNote = identity ? heldNamesNote(identity) : undefined;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            address,
            type: "wallet",
            sui_name: nameRes,
            // Stated at the point of use, not just in the tool description: a
            // name is the strongest pull toward off-chain identity this server
            // emits, and it is the least verified thing in the response.
            ...(nameRes
              ? {
                  sui_name_caveat:
                    "Self-chosen, purchasable handle — not identity and not verified. Anyone may register a name resembling an exchange, project or person. Corroborate before treating it as attribution.",
                }
              : {}),
            sui_balance: suiBalance,
            token_count: nonZeroTokens,
            // Absent means this address has never SENT a transaction, so it
            // has produced no signature to read. That is not the same as an
            // ordinary single-key wallet, and the caveat says so rather than
            // letting the silence be read as one.
            authentication: auth ?? null,
            ...(auth
              ? {}
              : {
                  authentication_caveat:
                    "This address has never sent a transaction, so how it authenticates is unknown. It may be a multisig, a zkLogin account or a single key — a receive-only treasury multisig is indistinguishable from a fresh personal wallet until it spends.",
                }),
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
          }, null, 2),
        }],
      };
    }
  );
}
