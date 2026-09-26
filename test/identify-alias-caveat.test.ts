import { describe, it, expect, vi, beforeEach } from "vitest";
import { notFoundError } from "./helpers/service-shapes.js";
import { createMockClient, createMockGraphql } from "./helpers/mock-grpc.js";
import type * as IdentityModule from "../src/utils/identity.js";
import type { AddressIdentity } from "../src/utils/identity.js";

/**
 * identify_address on a key that has only ever signed as an address alias:
 * its scheme comes from the reverse alias scan, so the caveat has to say
 * when that scan was read and whether it reached every owner.
 */

const mockSui = createMockClient();
const mockGqlQuery = createMockGraphql();
const mockDescribeAddresses = vi.fn();
vi.mock("../src/clients/grpc.js", () => ({ sui: mockSui, archive: mockSui }));
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/utils/identity.js", async () => ({
  ...(await vi.importActual<typeof IdentityModule>("../src/utils/identity.js")),
  describeAddresses: mockDescribeAddresses,
}));

// Loaded after the mocks above, which it must see.
const { registerIdentifyTools } = await import("../src/tools/identify.js");
let handler: (a: { address: string }) => Promise<{ content: { text: string }[] }> = null as never;
registerIdentifyTools({
  tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
    if (name === "identify_address") handler = h;
  },
} as never);

const ALIAS = "0xe28b8db376deb260de751dc05f4f55fc31895b479117ca3560d2f55730510a94";
const OWNER = "0xd763599972ea5a8cfe53d182371ee010dc52ace7e39ccff7d8803ba7100fa46a";

/** describeAddresses' answer for a key found signing as an alias, as the reverse scan produces it. */
const aliasSigner = (extra: Partial<AddressIdentity>): AddressIdentity => ({
  address: ALIAS,
  kind: "wallet",
  authentication: { scheme: "ed25519", public_key: "AAAA", signed_source_tx: "D9xPFEB7njk91bBLb5q2iDfnuYcfCPmGpp5Q96PhjLRe" } as AddressIdentity["authentication"],
  signed_as_alias_for: { owner: OWNER, digest: "D9xPFEB7njk91bBLb5q2iDfnuYcfCPmGpp5Q96PhjLRe" },
  alias_delegate_for: [OWNER],
  alias_scan_as_of: "2026-09-26T10:00:00.000Z",
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSui.ledgerService.getObject.mockRejectedValue(notFoundError());
  mockGqlQuery.mockResolvedValue({
    epoch: { validatorSet: { activeValidators: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } },
  });
  mockSui.getBalance.mockResolvedValue({ balance: { coinType: "0x2::sui::SUI", balance: "0" } });
  mockSui.nameService.reverseLookupName.mockResolvedValue({ response: { record: null } });
  mockSui.listBalances.mockResolvedValue({ balances: [] });
});

describe("identify_address — a key known only from alias signatures", () => {
  it("states when the reverse scan was read", async () => {
    mockDescribeAddresses.mockResolvedValue(new Map([[ALIAS, aliasSigner({})]]));
    const r = JSON.parse((await handler({ address: ALIAS })).content[0].text);
    expect(r.alias_scan_as_of).toBe("2026-09-26T10:00:00.000Z");
    expect(r.authentication_caveat).toContain("read at 2026-09-26T10:00:00.000Z");
    expect(r.authentication_caveat).not.toMatch(/did not fully complete/);
  });

  /** A signature found before the scan failed is real, but the owner list beside it may be short. */
  it("says alias_delegate_for may be missing owners when the scan behind a found signature was partial", async () => {
    mockDescribeAddresses.mockResolvedValue(new Map([[ALIAS, aliasSigner({ alias_scan_unavailable: true })]]));
    const r = JSON.parse((await handler({ address: ALIAS })).content[0].text);
    expect(r.signed_as_alias_for.owner).toBe(OWNER);
    expect(r.authentication_caveat).toMatch(/did not fully complete.*alias_delegate_for may be missing owners/);
  });
});
