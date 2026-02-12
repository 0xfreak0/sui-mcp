import { z } from "zod";
import { sui } from "../clients/grpc.js";
import { gqlQuery } from "../clients/graphql.js";
import { formatOwner } from "../utils/formatting.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface ValidatorMatch {
  name: string;
  staking_pool_sui_balance: string | null;
  commission_rate_bps: number | null;
}

async function findValidator(address: string): Promise<ValidatorMatch | null> {
  try {
    const data = await gqlQuery<{
      epoch: {
        validatorSet: {
          activeValidators: {
            nodes: Array<{
              contents?: {
                json: {
                  metadata?: { sui_address?: string; name?: string };
                  staking_pool?: { sui_balance?: string };
                  commission_rate?: string;
                };
              };
            }>;
          };
        };
      };
    }>(
      `query {
        epoch {
          validatorSet {
            activeValidators(first: 200) {
              nodes { contents { json } }
            }
          }
        }
      }`
    );

    const match = data.epoch.validatorSet.activeValidators.nodes.find(
      (v) => v.contents?.json?.metadata?.sui_address === address
    );
    if (!match) return null;
    const json = match.contents!.json;
    return {
      name: json.metadata?.name ?? "Unknown",
      staking_pool_sui_balance: json.staking_pool?.sui_balance ?? null,
      commission_rate_bps: json.commission_rate != null ? Number(json.commission_rate) : null,
    };
  } catch {
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
      // Try to get object at this address first
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
      } catch {
        objectRes = null;
      }

      const obj = objectRes?.object;
      const objectType = obj?.objectType ?? "";

      // CASE 1: It's a Move package
      if (objectType === "package" || objectType.endsWith("::package::Package")) {
        let modules: string[] = [];
        try {
          const { response: pkgRes } = await sui.movePackageService.getPackage({
            packageId: address,
          });
          modules = pkgRes.package?.modules?.map((m) => m.name ?? "") ?? [];
        } catch { /* ignore */ }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              address,
              type: "package",
              module_count: modules.length,
              modules: modules.slice(0, 20),
              modules_truncated: modules.length > 20,
              hint: "Use get_package for full module details, or decompile_module for source code.",
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
            sui_balance: suiBalance,
            token_count: nonZeroTokens,
            hint: "Use get_wallet_overview for full portfolio, get_transaction_history for activity, or get_defi_positions for DeFi.",
          }, null, 2),
        }],
      };
    }
  );
}
