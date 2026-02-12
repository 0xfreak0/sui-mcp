import { sui } from "../clients/grpc.js";

/**
 * Batch-resolve SuiNS names for a list of addresses.
 * Returns a Map of address -> name (only entries that resolved).
 */
export async function batchResolveNames(
  addresses: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(addresses)];
  if (unique.length === 0) return new Map();

  const results = await Promise.allSettled(
    unique.map(async (address) => {
      const { response } = await sui.nameService.reverseLookupName({
        address,
      });
      const name = response.record?.name;
      return { address, name: name ?? null };
    }),
  );

  const nameMap = new Map<string, string>();
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.name) {
      nameMap.set(result.value.address, result.value.name);
    }
  }
  return nameMap;
}
