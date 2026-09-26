import { describe, it, expect, vi, beforeEach } from "vitest";
import { runWithNetwork } from "../src/config.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { resolveEventTypeFilter, resolveModuleEventFilter, RELOCATE_EVENT_MODULE_CHECKPOINT } = await import(
  "../src/utils/package-versions.js"
);

const V1 = `0x${"1".repeat(64)}`;
const V3 = `0x${"3".repeat(64)}`;
const V5 = `0x${"5".repeat(64)}`;

/** Type origins as the service reports them for a package upgraded twice. */
const origins = {
  package: {
    typeOrigins: [
      { module: "pool", struct: "SwapEvent", definingId: V1 },
      { module: "pool", struct: "Pool", definingId: V1 },
      { module: "pool", struct: "FlashLoanEvent", definingId: V3 },
      { module: "vault", struct: "DepositEvent", definingId: V3 },
    ],
  },
};

beforeEach(() => {
  mockGqlQuery.mockReset();
  mockGqlQuery.mockResolvedValue(origins);
});

describe("resolveEventTypeFilter", () => {
  it("rewrites a struct type to the version that defined it, keeping type arguments", async () => {
    const r = await resolveEventTypeFilter(`${V5}::pool::SwapEvent<0x2::sui::SUI>`);
    expect(r.filter).toBe(`${V1}::pool::SwapEvent<0x2::sui::SUI>`);
    expect(r.resolution?.requested).toBe(`${V5}::pool::SwapEvent<0x2::sui::SUI>`);
  });

  it("leaves a type already written with its defining package alone", async () => {
    const r = await resolveEventTypeFilter(`${V3}::vault::DepositEvent`);
    expect(r).toEqual({ filter: `${V3}::vault::DepositEvent` });
  });

  it("names the other defining packages when a module's types span versions", async () => {
    const r = await resolveEventTypeFilter(`${V1}::pool`);
    // The requested package defines some of them, so it is kept.
    expect(r.filter).toBe(`${V1}::pool`);
    expect(r.resolution?.other_defining_packages).toEqual([V3]);
  });

  it("passes a filter through when the package cannot be read", async () => {
    mockGqlQuery.mockResolvedValue({ package: null });
    const r = await resolveEventTypeFilter("0x9999::m::E");
    expect(r).toEqual({ filter: "0x9999::m::E" });
  });
});

describe("resolveModuleEventFilter", () => {
  const V1 = `0x${"1".repeat(64)}`;
  const V9 = `0x${"9".repeat(64)}`;
  const CUT = RELOCATE_EVENT_MODULE_CHECKPOINT.mainnet;

  /**
   * A router module like Turbos v9's `swap_router` has no event structs of
   * its own, so `typeOrigins` cannot resolve it. Before mainnet checkpoint
   * 69,982,635 (2024-10-17, `relocate_event_module`), Sui anchored a module's
   * runtime identity to the package's original id regardless:
   * `transactionModule` on a swap event fired through v9 named v1, so a
   * filter written with v9 matches nothing unless it is rewritten to v1.
   */
  it("rewrites a module filter to the package's original id for a window entirely before the cutover", async () => {
    mockGqlQuery.mockResolvedValue({
      packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const r = await resolveModuleEventFilter(`${V9}::swap_router`, CUT - 1000, CUT - 500);
    expect(r.segments).toEqual([{ filter: `${V1}::swap_router`, afterCheckpoint: CUT - 1000, beforeCheckpoint: CUT - 500 }]);
    expect(r.resolution?.requested).toBe(`${V9}::swap_router`);
    expect(r.resolution?.note).toMatch(/69982635/);
  });

  /**
   * From the cutover checkpoint on, `relocate_event_module` makes the
   * opposite true: an event carries the id of the version that was actually
   * called, so rewriting to the original id would now match nothing. A
   * window entirely at or after the cutover must query the requested id
   * unrewritten.
   */
  it("queries the requested id unrewritten for a window entirely at or after the cutover", async () => {
    mockGqlQuery.mockResolvedValue({
      packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const r = await resolveModuleEventFilter(`${V9}::swap_router`, CUT + 1000, CUT + 2000);
    expect(r.segments).toEqual([{ filter: `${V9}::swap_router`, afterCheckpoint: CUT + 1000, beforeCheckpoint: CUT + 2000 }]);
    expect(r.resolution?.note).toMatch(/mainnet checkpoint 69982635/);
  });

  it("splits into two segments and merges when the window spans the cutover", async () => {
    mockGqlQuery.mockResolvedValue({
      packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const r = await resolveModuleEventFilter(`${V9}::swap_router`, CUT - 1000, CUT + 1000);
    expect(r.segments).toEqual([
      { filter: `${V1}::swap_router`, afterCheckpoint: CUT - 1000, beforeCheckpoint: CUT },
      { filter: `${V9}::swap_router`, afterCheckpoint: CUT - 1, beforeCheckpoint: CUT + 1000 },
    ]);
    expect(r.resolution?.note).toMatch(/spans the cutover/);
  });

  it("splits into two segments when the window is unbounded on both edges", async () => {
    mockGqlQuery.mockResolvedValue({
      packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const r = await resolveModuleEventFilter(`${V9}::swap_router`);
    expect(r.segments.map((s) => s.filter)).toEqual([`${V1}::swap_router`, `${V9}::swap_router`]);
  });

  it("leaves a module filter already written with the original id alone", async () => {
    mockGqlQuery.mockResolvedValue({
      packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const r = await resolveModuleEventFilter(`${V1}::swap_router`, CUT - 1000, CUT - 500);
    expect(r).toEqual({ segments: [{ filter: `${V1}::swap_router`, afterCheckpoint: CUT - 1000, beforeCheckpoint: CUT - 500 }] });
  });

  it("produces no rewrite for a framework package upgraded in place", async () => {
    const P2 = "0x0000000000000000000000000000000000000000000000000000000000000002";
    mockGqlQuery.mockResolvedValue({
      packageVersions: { nodes: [{ address: P2, version: 1 }, { address: P2, version: 60 }], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const r = await resolveModuleEventFilter(`${P2}::kiosk`);
    expect(r).toEqual({ segments: [{ filter: `${P2}::kiosk`, afterCheckpoint: null, beforeCheckpoint: null }] });
  });

  it("passes a bare package-only filter through with the rewrite applied", async () => {
    mockGqlQuery.mockResolvedValue({
      packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 9 }], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const r = await resolveModuleEventFilter(V9, CUT - 1000, CUT - 500);
    expect(r.segments).toEqual([{ filter: V1, afterCheckpoint: CUT - 1000, beforeCheckpoint: CUT - 500 }]);
  });

  it("passes a filter through when the package cannot be read", async () => {
    mockGqlQuery.mockResolvedValue({ packageVersions: null });
    const r = await resolveModuleEventFilter("0x9999::m");
    expect(r).toEqual({ segments: [{ filter: "0x9999::m", afterCheckpoint: null, beforeCheckpoint: null }] });
  });

  const lineage = {
    packageVersions: { nodes: [{ address: V1, version: 1 }, { address: V9, version: 7 }], pageInfo: { hasNextPage: false, endCursor: null } },
  };

  /**
   * Testnet turned relocate_event_module on at checkpoint 118,397,835 (first
   * of epoch 518, 2024-10-09), later than mainnet's 69,982,635. Supra's
   * price_data_pull_v2 called through v7 at checkpoint 110,000,020 still
   * carries the original id, so a window between the two networks' cutovers
   * is rewritten on testnet.
   */
  it("uses testnet's own cutover, rewriting a window that sits between the mainnet and testnet cutovers", async () => {
    mockGqlQuery.mockResolvedValue(lineage);
    const r = await runWithNetwork("testnet", () =>
      resolveModuleEventFilter(`${V9}::price_data_pull_v2`, 110_000_000, 110_003_000),
    );
    expect(r.segments).toEqual([{ filter: `${V1}::price_data_pull_v2`, afterCheckpoint: 110_000_000, beforeCheckpoint: 110_003_000 }]);
    expect(r.resolution?.note).toMatch(/testnet checkpoint 118397835 \(2024-10-09\)/);
  });

  it("splits a testnet window at testnet's cutover", async () => {
    mockGqlQuery.mockResolvedValue(lineage);
    const TCUT = 118_397_835;
    const r = await runWithNetwork("testnet", () => resolveModuleEventFilter(`${V9}::m`, TCUT - 10, TCUT + 10));
    expect(r.segments).toEqual([
      { filter: `${V1}::m`, afterCheckpoint: TCUT - 10, beforeCheckpoint: TCUT },
      { filter: `${V9}::m`, afterCheckpoint: TCUT - 1, beforeCheckpoint: TCUT + 10 },
    ]);
    const post = await runWithNetwork("testnet", () => resolveModuleEventFilter(`${V9}::m`, TCUT + 10, TCUT + 20));
    expect(post.segments).toEqual([{ filter: `${V9}::m`, afterCheckpoint: TCUT + 10, beforeCheckpoint: TCUT + 20 }]);
  });

  /**
   * Devnet has had the flag on since genesis, so every devnet checkpoint is
   * post-cutover, and no devnet window, bounded or not, is rewritten to the
   * original id or split.
   */
  it("never rewrites to the original id on devnet, whose cutover is genesis", async () => {
    mockGqlQuery.mockResolvedValue(lineage);
    const bounded = await runWithNetwork("devnet", () => resolveModuleEventFilter(`${V9}::m`, 1_000_000, 1_000_500));
    expect(bounded.segments).toEqual([{ filter: `${V9}::m`, afterCheckpoint: 1_000_000, beforeCheckpoint: 1_000_500 }]);
    const unbounded = await runWithNetwork("devnet", () => resolveModuleEventFilter(`${V9}::m`));
    expect(unbounded.segments).toEqual([{ filter: `${V9}::m`, afterCheckpoint: null, beforeCheckpoint: null }]);
    expect(unbounded.resolution?.note).toMatch(/Devnet has had relocate_event_module on since genesis/);
  });

  /**
   * Bounds are exclusive, so a window ending at `before: CUT` holds nothing
   * at or after the cutover and one starting at `after: CUT - 1` holds
   * nothing before it. Neither may add an empty segment or claim to span.
   */
  it("keeps a segment only when it holds a checkpoint", async () => {
    mockGqlQuery.mockResolvedValue(lineage);
    const endsAtCut = await resolveModuleEventFilter(`${V9}::m`, CUT - 100, CUT);
    expect(endsAtCut.segments).toEqual([{ filter: `${V1}::m`, afterCheckpoint: CUT - 100, beforeCheckpoint: CUT }]);
    const startsAtCut = await resolveModuleEventFilter(`${V9}::m`, CUT - 1, CUT + 100);
    expect(startsAtCut.segments).toEqual([{ filter: `${V9}::m`, afterCheckpoint: CUT - 1, beforeCheckpoint: CUT + 100 }]);
    const oneEachSide = await resolveModuleEventFilter(`${V9}::m`, CUT - 2, CUT + 1);
    expect(oneEachSide.segments.map((s) => s.filter)).toEqual([`${V1}::m`, `${V9}::m`]);
  });

  /** Turbos swap_router: 22 versions, of which v1, v9 and v12 stand in. */
  const V12 = `0x${"c".repeat(64)}`;
  const turbos = {
    packageVersions: {
      nodes: [
        { address: V1, version: 1 },
        { address: V9, version: 9 },
        { address: V12, version: 12 },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };

  /**
   * The original id is what an investigator copies from every pre-cutover
   * event's emitting_module. After the cutover it matches calls through v1
   * only, so the result names the lineage's other ids, which carry the rest.
   */
  it("annotates an original-id filter over a post-cutover window with the lineage's other ids", async () => {
    mockGqlQuery.mockResolvedValue(turbos);
    const r = await resolveModuleEventFilter(`${V1}::swap_router`, CUT + 1000, CUT + 2000);
    expect(r.segments).toEqual([{ filter: `${V1}::swap_router`, afterCheckpoint: CUT + 1000, beforeCheckpoint: CUT + 2000 }]);
    expect(r.resolution?.other_version_ids).toEqual([V9, V12]);
    expect(r.resolution?.note).toMatch(/version 1 \(0x1+\) only/);
  });

  /**
   * An original-id window spanning the cutover is one query (the same id
   * serves both sides) whose later part covers v1's calls only, so it still
   * names the lineage's other ids.
   */
  it("keeps an original-id filter spanning the cutover as one query and annotates the post-cutover part", async () => {
    mockGqlQuery.mockResolvedValue(turbos);
    const r = await resolveModuleEventFilter(`${V1}::swap_router`, CUT - 1000, CUT + 1000);
    expect(r.segments).toEqual([{ filter: `${V1}::swap_router`, afterCheckpoint: CUT - 1000, beforeCheckpoint: CUT + 1000 }]);
    expect(r.resolution?.other_version_ids).toEqual([V9, V12]);
    expect(r.resolution?.note).toMatch(/spans the cutover/);
    const unbounded = await resolveModuleEventFilter(`${V1}::swap_router`);
    expect(unbounded.segments).toHaveLength(1);
    expect(unbounded.resolution?.other_version_ids).toEqual([V9, V12]);
  });

  /** A later version's post-cutover part covers that one version's calls, so the rest of the lineage is named. */
  it("names the other versions for a later-version filter that reaches the cutover", async () => {
    mockGqlQuery.mockResolvedValue(turbos);
    const post = await resolveModuleEventFilter(`${V9}::swap_router`, CUT + 1000, CUT + 2000);
    expect(post.resolution?.other_version_ids).toEqual([V1, V12]);
    expect(post.resolution?.note).toMatch(/version 9 \(0x9+\) only/);
    const spanning = await resolveModuleEventFilter(`${V9}::swap_router`, CUT - 1000, CUT + 1000);
    expect(spanning.resolution?.other_version_ids).toEqual([V1, V12]);
    const pre = await resolveModuleEventFilter(`${V9}::swap_router`, CUT - 1000, CUT - 500);
    expect(pre.resolution?.other_version_ids).toBeUndefined();
  });

  it("passes a single-version package through without a note", async () => {
    mockGqlQuery.mockResolvedValue({
      packageVersions: { nodes: [{ address: V9, version: 1 }], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const r = await resolveModuleEventFilter(`${V9}::m`, CUT + 1000, CUT + 2000);
    expect(r).toEqual({ segments: [{ filter: `${V9}::m`, afterCheckpoint: CUT + 1000, beforeCheckpoint: CUT + 2000 }] });
  });

  /** A failed lineage read passes the filter through with a note saying the result can miss events. */
  it("says so when the version list cannot be read", async () => {
    mockGqlQuery.mockRejectedValue(new Error("HTTP 429"));
    const r = await resolveModuleEventFilter(`${V9}::swap_router`, CUT + 1000, CUT + 2000);
    expect(r.segments).toEqual([{ filter: `${V9}::swap_router`, afterCheckpoint: CUT + 1000, beforeCheckpoint: CUT + 2000 }]);
    expect(r.resolution?.note).toMatch(/version list could not be read \(HTTP 429\)/);
  });
});
