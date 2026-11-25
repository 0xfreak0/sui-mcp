import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { PAS_PACKAGES, PAS_BALANCE_PAGES, PasNamespaceUnavailable, pasAccountAddress, readPasAccount, readPasBalance, resetPasCache } =
  await import("../src/utils/pas.js");
const { runWithNetwork } = await import("../src/config.js");

const PKG = PAS_PACKAGES.mainnet!;
/** The mainnet Namespace, and a real owner and its Account, read from mainnet. */
const NS = "0xf4d3d9ecc611dcb361aae1548ff08792da4bf9d8a78b1398dbdc601e1e3b118e";
const OWNER = "0x031e3dc4a4385230608295787eec2fcf5b77328fc5338b9ffcadb5c4ea4ab493";
const ACCOUNT = "0x1699d27e6fcb007e9d5ba6324bb90e6abed50feb3c8f66e6c1864cfc9cff8387";
const COIN = "0xb0c64367bf48666b3b726d3601fe4ec39fc4af30f48399bae30daac6cfb7fb66::voloro::Voloro";

const namespace = { objects: { nodes: [{ address: NS }] } };
const page = (nodes: Array<[string, string]>, more = false, end: string | null = null, created = true) => ({
  object: created ? { address: ACCOUNT } : null,
  address: {
    balances: {
      pageInfo: { hasNextPage: more, endCursor: end },
      nodes: nodes.map(([c, b]) => ({ coinType: { repr: c }, totalBalance: b })),
    },
  },
});
const mainnet = <T>(f: () => Promise<T>) => runWithNetwork("mainnet", f);

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
    mockGqlQuery.mockResolvedValueOnce(namespace).mockResolvedValueOnce(page([[COIN, "999000000"], ["0x2::sui::SUI", "0"]]));
    expect(await mainnet(() => readPasAccount(OWNER))).toEqual({
      owner: OWNER,
      account_address: ACCOUNT,
      account_created: true,
      balances: [{ coin_type: COIN, balance: "999000000" }],
      balances_truncated: false,
      next_cursor: null,
    });
    expect(mockGqlQuery.mock.calls[1][1]).toEqual({ a: ACCOUNT, after: null });
  });

  it("reads funds sent before the account exists", async () => {
    mockGqlQuery.mockResolvedValueOnce(namespace).mockResolvedValueOnce(page([[COIN, "5"]], false, null, false));
    expect(await mainnet(() => readPasAccount(OWNER))).toMatchObject({ account_created: false, balances: [{ coin_type: COIN, balance: "5" }] });
  });

  it("pages on, and hands back the cursor once its page bound is spent", async () => {
    mockGqlQuery.mockResolvedValueOnce(namespace);
    for (let i = 0; i < PAS_BALANCE_PAGES; i++) mockGqlQuery.mockResolvedValueOnce(page([[`0x${i + 1}::c::C`, "1"]], true, `c${i}`));
    const a = await mainnet(() => readPasAccount(OWNER));
    expect(a!.balances).toHaveLength(PAS_BALANCE_PAGES);
    expect(a).toMatchObject({ balances_truncated: true, next_cursor: `c${PAS_BALANCE_PAGES - 1}` });
    expect(mockGqlQuery.mock.calls[2][1]).toEqual({ a: ACCOUNT, after: "c0" });
  });

  it("stops a page that claims more with no advancing cursor, and gives no cursor to follow", async () => {
    mockGqlQuery.mockResolvedValueOnce(namespace).mockResolvedValueOnce(page([[COIN, "1"]], true, null));
    expect(await mainnet(() => readPasAccount(OWNER))).toMatchObject({ balances_truncated: true, next_cursor: null });
    expect(mockGqlQuery).toHaveBeenCalledTimes(2);
  });

  it("reads one coin at the account directly", async () => {
    mockGqlQuery.mockResolvedValueOnce(namespace).mockResolvedValueOnce({ address: { balance: { totalBalance: "999000000" } } });
    expect(await mainnet(() => readPasBalance(OWNER, COIN))).toEqual({ account_address: ACCOUNT, balance: "999000000" });
    expect(mockGqlQuery.mock.calls[1][1]).toEqual({ a: ACCOUNT, t: COIN });
  });

  it("reads the namespace once per network", async () => {
    mockGqlQuery.mockResolvedValueOnce(namespace).mockResolvedValue(page([]));
    await mainnet(() => readPasAccount(OWNER));
    await mainnet(() => readPasAccount(OWNER));
    expect(mockGqlQuery).toHaveBeenCalledTimes(3);
  });

  it("gives no account where PAS is not deployed", async () => {
    expect(await runWithNetwork("devnet", () => readPasAccount(OWNER))).toBeNull();
    expect(await runWithNetwork("devnet", () => readPasBalance(OWNER, COIN))).toBeNull();
    expect(mockGqlQuery).not.toHaveBeenCalled();
  });

  it("calls an unidentified namespace unavailable, never no account, and does not re-ask for a while", async () => {
    mockGqlQuery.mockResolvedValueOnce({ objects: { nodes: [{ address: NS }, { address: ACCOUNT }] } });
    await expect(mainnet(() => readPasAccount(OWNER))).rejects.toBeInstanceOf(PasNamespaceUnavailable);
    await expect(mainnet(() => readPasBalance(OWNER, COIN))).rejects.toThrow(/2 found/);
    expect(mockGqlQuery).toHaveBeenCalledTimes(1);
  });

  it("throws on a failed read rather than reporting no balances", async () => {
    mockGqlQuery.mockRejectedValueOnce(new Error("429"));
    await expect(mainnet(() => readPasAccount(OWNER))).rejects.toThrow("429");
  });
});
