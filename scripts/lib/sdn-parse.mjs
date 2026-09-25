/**
 * Pure parser for OFAC's SDN_ENHANCED.XML, used by scripts/sync-sanctions.mjs.
 *
 * Returns every "Digital Currency Address - <CODE>" feature, counted by code,
 * and the subset that maps onto a namespace this server normalizes.
 */

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SUI = /^0x[0-9a-fA-F]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The namespace an OFAC (currency, address) pair belongs to, or null. */
export function namespaceForSdnAddress(currency, address) {
  if (EVM.test(address)) return "eip155";
  if (SUI.test(address) && currency === "SUI") return "sui";
  if (currency === "SOL" && BASE58.test(address)) return "solana";
  return null;
}

function normalize(namespace, address) {
  if (namespace === "eip155") return address.toLowerCase();
  if (namespace === "sui") return address.toLowerCase();
  return address; // base58 is case-significant
}

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

export function parseSdnDigitalCurrency(xml) {
  const dataAsOf = /<dataAsOf>([^<]+)<\/dataAsOf>/.exec(xml)?.[1] ?? null;
  const byCurrency = {};
  const accounts = new Map();
  let total = 0;

  const start = xml.indexOf("<entities>");
  const body = start >= 0 ? xml.slice(start) : xml;
  for (const chunk of body.split("<entity id=").slice(1)) {
    const features = [
      ...chunk.matchAll(
        /<type featureTypeId="\d+">Digital Currency Address - ([A-Z0-9]+)<\/type>[\s\S]*?<value>([^<]+)<\/value>/g,
      ),
    ];
    if (features.length === 0) continue;
    const entityId = /^"(\d+)"/.exec(chunk)?.[1] ?? null;
    const name = decode(/<formattedFullName>([^<]+)<\/formattedFullName>/.exec(chunk)?.[1] ?? "");
    const programs = [...chunk.matchAll(/<sanctionsProgram[^>]*>([^<]+)<\/sanctionsProgram>/g)].map((m) => m[1]);

    for (const [, currency, rawValue] of features) {
      const value = rawValue.trim();
      total++;
      byCurrency[currency] = (byCurrency[currency] ?? 0) + 1;
      const namespace = namespaceForSdnAddress(currency, value);
      if (!namespace) continue;
      const address = normalize(namespace, value);
      const k = `${namespace}:${address}`;
      const existing = accounts.get(k);
      if (existing) {
        if (!existing.currencies.includes(currency)) existing.currencies.push(currency);
        continue;
      }
      accounts.set(k, {
        namespace,
        address,
        currencies: [currency],
        sdn_name: name,
        sdn_entity_id: entityId,
        programs,
      });
    }
  }

  const list = [...accounts.values()].sort((a, b) => `${a.namespace}:${a.address}`.localeCompare(`${b.namespace}:${b.address}`));
  return {
    dataAsOf,
    total,
    byCurrency: Object.fromEntries(Object.entries(byCurrency).sort(([, a], [, b]) => b - a)),
    suiCount: list.filter((a) => a.namespace === "sui").length,
    accounts: list,
  };
}
