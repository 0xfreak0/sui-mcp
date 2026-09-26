import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `get_object` and `identify_address` on a kiosk name the KioskOwnerCap
 * holder (the only party who can list, delist or withdraw) beside the
 * kiosk's self-declared `owner` field, through `resolveKioskCapHolder`.
 */

const mockResolveKioskCapHolder = vi.fn();
const getObject = vi.fn();
vi.mock("../src/utils/kiosk.js", async () => {
  const actual = await vi.importActual<typeof import("../src/utils/kiosk.js")>("../src/utils/kiosk.js");
  return { ...actual, resolveKioskCapHolder: mockResolveKioskCapHolder };
});
vi.mock("../src/clients/grpc.js", () => {
  const client = { ledgerService: { getObject } };
  return { sui: client, archive: client };
});
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: vi.fn() }));
vi.mock("../src/utils/labels.js", () => ({ getLabel: () => null, isSinkCategory: () => false, labelProvenance: () => null }));
vi.mock("../src/utils/guardians.js", () => ({ guardiansFlagsForObjectType: () => [], guardiansFlagsForPackage: () => [] }));
vi.mock("../src/utils/address-balance.js", () => ({ objectAddressBalanceFields: async () => ({}) }));

const KIOSK = "0x306b2b5bcec1a7d1a4e780dce1f418fba11f21081575f42c261d09de5eedfd90";
const CAP = "0x0785656e67232a0a5d9f895d980e7ab0dffc982fb83ac7c7e4d19d2068855fcc";
const DRAINER = "0x5ecf90fa681d13629e91067782316d89893c5cede1b889d7e2ea4eabd0e54088";
const KIOSK_OBJECT_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::kiosk::Kiosk";

function grpcKiosk() {
  return {
    response: {
      object: {
        objectId: KIOSK,
        version: 1n,
        digest: "d1",
        objectType: KIOSK_OBJECT_TYPE,
        owner: { kind: 3, version: 1n }, // Owner_OwnerKind.SHARED
        json: { owner: "0x245937f3", item_count: 1 },
      },
    },
  };
}

beforeEach(() => {
  mockResolveKioskCapHolder.mockReset();
  getObject.mockReset();
  getObject.mockResolvedValue(grpcKiosk());
  mockResolveKioskCapHolder.mockResolvedValue({
    status: "resolved",
    result: { cap_id: CAP, creation_tx: "mintTx", original_holder: { kind: "address", address: "0xvictim" }, holder: { kind: "address", address: DRAINER } },
  });
});

describe("get_object — kiosk cap holder", () => {
  it("names the KioskOwnerCap holder alongside the self-declared owner field", async () => {
    const { registerObjectTools } = await import("../src/tools/objects.js");
    let handler: (a: { object_id: string }) => Promise<{ content: { text: string }[] }> = null as never;
    registerObjectTools({
      tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
        if (name === "get_object") handler = h;
      },
    } as never);
    const r = JSON.parse((await handler({ object_id: KIOSK })).content[0].text);
    expect(r.kiosk_cap_holder).toEqual({ kind: "address", address: DRAINER });
    expect(r.kiosk_cap_id).toBe(CAP);
    expect(r.kiosk_owner_field_caveat).toMatch(/self-declared/i);
    expect(mockResolveKioskCapHolder).toHaveBeenCalledWith(KIOSK);
  });

  it("does not attempt a kiosk lookup for a non-kiosk object", async () => {
    getObject.mockResolvedValue({
      response: { object: { objectId: "0xnotkiosk", version: 1n, digest: "d", objectType: "0xabc::pool::Pool", owner: { kind: 1, address: "0xa" }, json: {} } },
    });
    const { registerObjectTools } = await import("../src/tools/objects.js");
    let handler: (a: { object_id: string }) => Promise<{ content: { text: string }[] }> = null as never;
    registerObjectTools({
      tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
        if (name === "get_object") handler = h;
      },
    } as never);
    const r = JSON.parse((await handler({ object_id: "0xnotkiosk" })).content[0].text);
    expect(r.kiosk_cap_holder).toBeUndefined();
    expect(mockResolveKioskCapHolder).not.toHaveBeenCalled();
  });

  /**
   * The cap holder is current state, so a read of a specific version gets
   * no kiosk lookup: the cap's current holder is not who controlled the
   * kiosk in that snapshot. `heldRequest` in `get_object` is gated on
   * `!version` for the same reason.
   */
  it("skips the kiosk lookup entirely for a specific version", async () => {
    const { registerObjectTools } = await import("../src/tools/objects.js");
    let handler: (a: { object_id: string; version?: string }) => Promise<{ content: { text: string }[] }> = null as never;
    registerObjectTools({
      tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
        if (name === "get_object") handler = h;
      },
    } as never);
    const r = JSON.parse((await handler({ object_id: KIOSK, version: "6379401" })).content[0].text);
    expect(r.kiosk_cap_holder).toBeUndefined();
    expect(r.kiosk_owner_field_caveat).toBeUndefined();
    expect(mockResolveKioskCapHolder).not.toHaveBeenCalled();
  });

  /**
   * A cap wrapped inside a PersonalKioskCap: `wrapped_in` names what holds
   * it so the resolved `holder` does not read as a guess.
   */
  it("surfaces kiosk_cap_wrapped_in when the cap is wrapped rather than a top-level object", async () => {
    mockResolveKioskCapHolder.mockResolvedValue({
      status: "resolved",
      result: {
        cap_id: CAP,
        creation_tx: "mintTx",
        original_holder: { kind: "address", address: "0xvictim" },
        holder: { kind: "address", address: DRAINER },
        wrapped_in: [{ object_id: "0xpersonalcap", type: "0xpersonal::personal_kiosk::PersonalKioskCap" }],
      },
    });
    const { registerObjectTools } = await import("../src/tools/objects.js");
    let handler: (a: { object_id: string }) => Promise<{ content: { text: string }[] }> = null as never;
    registerObjectTools({
      tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
        if (name === "get_object") handler = h;
      },
    } as never);
    const r = JSON.parse((await handler({ object_id: KIOSK })).content[0].text);
    expect(r.kiosk_cap_holder).toEqual({ kind: "address", address: DRAINER });
    expect(r.kiosk_cap_wrapped_in).toEqual([{ object_id: "0xpersonalcap", type: "0xpersonal::personal_kiosk::PersonalKioskCap" }]);
  });

  /**
   * A GraphQL failure (a 429, a timeout) inside resolveKioskCapHolder comes
   * back as a status the caller narrows explicitly, so `get_object` keeps
   * the object answer it already read. This covers the tool's handling of
   * that status, beyond kiosk.ts itself not throwing.
   */
  it("degrades a failed kiosk cap lookup to a note instead of failing the call", async () => {
    mockResolveKioskCapHolder.mockResolvedValue({ status: "lookup_failed", message: "429 Too Many Requests" });
    const { registerObjectTools } = await import("../src/tools/objects.js");
    let handler: (a: { object_id: string }) => Promise<{ content: { text: string }[] }> = null as never;
    registerObjectTools({
      tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
        if (name === "get_object") handler = h;
      },
    } as never);
    const r = JSON.parse((await handler({ object_id: KIOSK })).content[0].text);
    expect(r.object_id).toBe(KIOSK);
    expect(r.kiosk_cap_holder).toBeUndefined();
    expect(r.kiosk_cap_holder_note).toMatch(/429 Too Many Requests/);
  });
});

describe("identify_address — kiosk cap holder", () => {
  it("names the KioskOwnerCap holder for a kiosk", async () => {
    const { registerIdentifyTools } = await import("../src/tools/identify.js");
    let handler: (a: { address: string }) => Promise<{ content: { text: string }[] }> = null as never;
    registerIdentifyTools({
      tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
        if (name === "identify_address") handler = h;
      },
    } as never);
    const r = JSON.parse((await handler({ address: KIOSK })).content[0].text);
    expect(r.type).toBe("shared_object");
    expect(r.kiosk_cap_holder).toEqual({ kind: "address", address: DRAINER });
    expect(r.kiosk_cap_id).toBe(CAP);
  });

  /** The same wiring as get_object, for the "recommended first step" tool:
   *  a failed kiosk lookup degrades to a note. */
  it("degrades a failed kiosk cap lookup to a note instead of failing the call", async () => {
    mockResolveKioskCapHolder.mockResolvedValue({ status: "lookup_failed", message: "429 Too Many Requests" });
    const { registerIdentifyTools } = await import("../src/tools/identify.js");
    let handler: (a: { address: string }) => Promise<{ content: { text: string }[] }> = null as never;
    registerIdentifyTools({
      tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
        if (name === "identify_address") handler = h;
      },
    } as never);
    const r = JSON.parse((await handler({ address: KIOSK })).content[0].text);
    expect(r.type).toBe("shared_object");
    expect(r.kiosk_cap_holder).toBeUndefined();
    expect(r.kiosk_cap_holder_note).toMatch(/429 Too Many Requests/);
  });

  it("surfaces kiosk_cap_wrapped_in when the cap is wrapped rather than a top-level object", async () => {
    mockResolveKioskCapHolder.mockResolvedValue({
      status: "resolved",
      result: {
        cap_id: CAP,
        creation_tx: "mintTx",
        original_holder: { kind: "address", address: "0xvictim" },
        holder: { kind: "address", address: DRAINER },
        wrapped_in: [{ object_id: "0xpersonalcap", type: "0xpersonal::personal_kiosk::PersonalKioskCap" }],
      },
    });
    const { registerIdentifyTools } = await import("../src/tools/identify.js");
    let handler: (a: { address: string }) => Promise<{ content: { text: string }[] }> = null as never;
    registerIdentifyTools({
      tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
        if (name === "identify_address") handler = h;
      },
    } as never);
    const r = JSON.parse((await handler({ address: KIOSK })).content[0].text);
    expect(r.kiosk_cap_holder).toEqual({ kind: "address", address: DRAINER });
    expect(r.kiosk_cap_wrapped_in).toEqual([{ object_id: "0xpersonalcap", type: "0xpersonal::personal_kiosk::PersonalKioskCap" }]);
  });

  it("still classifies the object when the kiosk cap-holder lookup fails, instead of erroring out", async () => {
    mockResolveKioskCapHolder.mockRejectedValue(new Error("Rate-limited: too many requests (HTTP 429)"));
    const { registerIdentifyTools } = await import("../src/tools/identify.js");
    let handler: (a: { address: string }) => Promise<{ content: { text: string }[]; isError?: boolean }> = null as never;
    registerIdentifyTools({
      tool: (name: string, _d: string, _s: unknown, h: typeof handler) => {
        if (name === "identify_address") handler = h;
      },
    } as never);
    const res = await handler({ address: KIOSK });
    expect(res.isError).toBeUndefined();
    const r = JSON.parse(res.content[0].text);
    expect(r.type).toBe("shared_object");
    expect(r.kiosk_cap_holder).toBeUndefined();
    expect(r.kiosk_cap_holder_note).toMatch(/429/);
  });
});
