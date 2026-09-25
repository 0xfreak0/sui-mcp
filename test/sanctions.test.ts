import { describe, expect, it } from "vitest";
import { createSanctionsIndex, sanctions, type SanctionsFile } from "../src/utils/sanctions.js";
// @ts-expect-error -- plain .mjs script helper, no type declarations
import { namespaceForSdnAddress, parseSdnDigitalCurrency } from "../scripts/lib/sdn-parse.mjs";

// One SDN entity as SDN_ENHANCED.XML carries it (abridged), with an ETH, a
// USDT-on-Tron and a SOL address.
const XML = `<?xml version="1.0" encoding="utf-8"?>
<sanctionsData>
  <publicationInfo><dataAsOf>2026-09-23T00:00:00-04:00</dataAsOf></publicationInfo>
  <entities>
    <entity id="57056">
      <sanctionsPrograms><sanctionsProgram refId="1" id="2">DPRK4</sanctionsProgram></sanctionsPrograms>
      <names><name><translations><translation><formattedFullName>AMNOKGANG TECHNOLOGY DEVELOPMENT COMPANY</formattedFullName></translation></translations></name></names>
      <features>
        <feature id="1">
          <type featureTypeId="345">Digital Currency Address - ETH</type>
          <versionId>1</versionId>
          <value>0x0330070FD38EC3bb94f58fa55d40368271E9E54A</value>
        </feature>
        <feature id="2">
          <type featureTypeId="400">Digital Currency Address - USDT</type>
          <versionId>2</versionId>
          <value>TXqWgZ8TtBfaZq3u6YkXgA6yVvVh7qvbmE</value>
        </feature>
        <feature id="3">
          <type featureTypeId="1167">Digital Currency Address - SOL</type>
          <versionId>3</versionId>
          <value>5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d</value>
        </feature>
      </features>
    </entity>
  </entities>
</sanctionsData>`;

describe("parseSdnDigitalCurrency", () => {
  const parsed = parseSdnDigitalCurrency(XML);

  it("counts every digital currency address, stored or not", () => {
    expect(parsed.total).toBe(3);
    expect(parsed.byCurrency).toEqual({ ETH: 1, USDT: 1, SOL: 1 });
    expect(parsed.dataAsOf).toBe("2026-09-23T00:00:00-04:00");
    expect(parsed.suiCount).toBe(0);
  });

  it("stores the EVM key lowercased and the Solana key as written, and skips the Tron one", () => {
    expect(parsed.accounts.map((a: { namespace: string; address: string }) => `${a.namespace}:${a.address}`)).toEqual([
      "eip155:0x0330070fd38ec3bb94f58fa55d40368271e9e54a",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    ]);
    expect(parsed.accounts[0].sdn_name).toBe("AMNOKGANG TECHNOLOGY DEVELOPMENT COMPANY");
    expect(parsed.accounts[0].programs).toEqual(["DPRK4"]);
  });

  it("maps a base58 USDT address to no namespace, since Tron and Solana share the alphabet", () => {
    expect(namespaceForSdnAddress("USDT", "TXqWgZ8TtBfaZq3u6YkXgA6yVvVh7qvbmE")).toBeNull();
    expect(namespaceForSdnAddress("SUI", "0x" + "1".repeat(64))).toBe("sui");
    expect(namespaceForSdnAddress("APT", "0x" + "1".repeat(64))).toBeNull();
  });
});

describe("sanctions index", () => {
  const parsed = parseSdnDigitalCurrency(XML);
  const index = createSanctionsIndex({
    source_url: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ENHANCED.XML",
    list: "OFAC Specially Designated Nationals (SDN) List",
    data_as_of: parsed.dataAsOf,
    retrieved_at: "2026-09-25",
    total_digital_currency_addresses: parsed.total,
    by_currency: parsed.byCurrency,
    sui_address_count: parsed.suiCount,
    accounts: parsed.accounts,
  } satisfies SanctionsFile);

  it("matches an ETH-listed key on any EVM chain, in any casing", () => {
    expect(index.match("eip155:1:0x0330070fd38ec3bb94f58fa55d40368271e9e54a")?.sdn_name).toBe(
      "AMNOKGANG TECHNOLOGY DEVELOPMENT COMPANY",
    );
    expect(index.match("eip155:56:0x0330070FD38EC3bb94f58fa55d40368271E9E54A")?.listed_as).toEqual(["ETH"]);
  });

  it("does not match a Sui account that happens to share hex digits", () => {
    expect(index.match("0x0330070fd38ec3bb94f58fa55d40368271e9e54a")).toBeNull();
  });

  it("returns null rather than throwing on a malformed reference", () => {
    expect(index.match("eip155:1:not-an-address")).toBeNull();
  });
});

describe("shipped sanctions list", () => {
  it("states how many Sui addresses OFAC lists, which screen_address reports", () => {
    const cov = sanctions().coverage();
    expect(cov.sui_addresses_listed).toBe(0);
    expect(cov.matchable_addresses).toBeGreaterThan(0);
    expect(cov.data_as_of).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
});
