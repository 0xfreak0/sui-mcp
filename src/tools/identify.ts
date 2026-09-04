import { z } from "zod";
import { errorResult, isNotFound } from "../utils/errors.js";
import { fetchActiveValidators, findValidatorByAddress } from "../utils/validators.js";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { suivisionPackageUrl } from "../config.js";
import { formatOwner } from "../utils/formatting.js";
import { isCuratedProtocol, lookupProtocolDisplay, prefetchProtocolNames } from "../protocols/registry.js";
import { notePackageRoot } from "../protocols/package-roots.js";
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

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              address,
              type: isShared ? "shared_object" : "object",
              object_type: objectType,
              owner,
              version: obj.version?.toString(),
              hint: isShared
                ? "This is a shared object (e.g. a pool, registry, or protocol state). Use get_object for full content."
                : "This is an owned object. Use get_object for full content.",
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
      const [balanceRes, nameRes, ownedRes] = await Promise.all([
        sui.getBalance({ owner: address }).catch(() => null),
        sui.nameService
          .reverseLookupName({ address })
          .then(({ response }) => response.record?.name ?? null)
          .catch(() => null),
        sui.listBalances({ owner: address, limit: 10, cursor: null }).catch(() => null),
      ]);

      const suiBalance = balanceRes?.balance?.balance ?? "0";
      const nonZeroTokens = ownedRes?.balances?.filter((b) => b.balance !== "0").length ?? 0;

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
            hint: "Use get_wallet_overview for full portfolio, get_transaction_history for activity, or get_defi_positions for DeFi.",
          }, null, 2),
        }],
      };
    }
  );
}
