import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { PAS_PACKAGES, pasAccountAddress, readPasAccount, resetPasCache } = await import("../src/utils/pas.js");
const { runWithNetwork } = await import("../src/config.js");

const PKG = PAS_PACKAGES.mainnet!;
/** The mainnet Namespace, and a real owner and its Account, read from mainnet. */
const NS = "0xf4d3d9ecc611dcb361aae1548ff08792da4bf9d8a78b1398dbdc601e1e3b118e";
const OWNER = "0x031e3dc4a4385230608295787eec2fcf5b77328fc5338b9ffcadb5c4ea4ab493";
const ACCOUNT = "0x1699d27e6fcb007e9d5ba6324bb90e6abed50feb3c8f66e6c1864cfc9cff8387";
const COIN = "0xb0c64367bf48666b3b726d3601fe4ec39fc4af30f48399bae30daac6cfb7fb66::voloro::Voloro";

describe("PAS accounts", () => {
  beforeEach(() => {
    mockGqlQuery.mockReset();
    resetPasCache();
  });

  it("derives the account address the standard claims for an owner", () => {
    expect(pasAccountAddress(PKG, NS, OWNER)).toBe(ACCOUNT);
    // Short and upper-case spellings of the owner derive the same account.
    expect(pasAccountAddress(PKG, NS, OWNER.toUpperCase().replace("0X", "0x"))).toBe(ACCOUNT);
  });

  it("reads the balances at the account address and whether the account exists", async () => {
    mockGqlQuery
      .mockResolvedValueOnce({ objects: { nodes: [{ address: NS }] } })
      .mockResolvedValueOnce({
        object: { address: ACCOUNT },
        address: {
          balances: {
            pageInfo: { hasNextPage: false },
            nodes: [
              { coinType: { repr: COIN }, totalBalance: "999000000", addressBalance: "999000000" },
              { coinType: { repr: "0x2::sui::SUI" }, totalBalance: "0" },
            ],
          },
        },
      });
    const a = await runWithNetwork("mainnet", () => readPasAccount(OWNER));
    expect(a).toEqual({
      owner: OWNER,
      account_address: ACCOUNT,
      account_created: true,
      balances: [{ coin_type: COIN, balance: "999000000" }],
      balances_truncated: false,
    });
    expect(mockGqlQuery.mock.calls[1][1]).toEqual({ a: ACCOUNT });
  });

  it("reads funds sent before the account exists", async () => {
    mockGqlQuery
      .mockResolvedValueOnce({ objects: { nodes: [{ address: NS }] } })
      .mockResolvedValueOnce({ object: null, address: { balances: { pageInfo: { hasNextPage: false }, nodes: [{ coinType: { repr: COIN }, totalBalance: "5" }] } } });
    const a = await runWithNetwork("mainnet", () => readPasAccount(OWNER));
    expect(a).toMatchObject({ account_created: false, balances: [{ coin_type: COIN, balance: "5" }] });
  });

  it("reads the namespace once per network", async () => {
    const empty = { object: null, address: { balances: { pageInfo: { hasNextPage: false }, nodes: [] } } };
    mockGqlQuery.mockResolvedValueOnce({ objects: { nodes: [{ address: NS }] } }).mockResolvedValue(empty);
    await runWithNetwork("mainnet", () => readPasAccount(OWNER));
    await runWithNetwork("mainnet", () => readPasAccount(OWNER));
    expect(mockGqlQuery).toHaveBeenCalledTimes(3);
  });

  it("gives no account where PAS is not deployed, or its namespace is not the one expected", async () => {
    expect(await runWithNetwork("devnet", () => readPasAccount(OWNER))).toBeNull();
    mockGqlQuery.mockResolvedValueOnce({ objects: { nodes: [{ address: NS }, { address: ACCOUNT }] } });
    expect(await runWithNetwork("mainnet", () => readPasAccount(OWNER))).toBeNull();
    expect(mockGqlQuery).toHaveBeenCalledTimes(1);
  });

  it("throws on a failed read rather than reporting no balances", async () => {
    mockGqlQuery.mockRejectedValueOnce(new Error("429"));
    await expect(runWithNetwork("mainnet", () => readPasAccount(OWNER))).rejects.toThrow("429");
  });
});
