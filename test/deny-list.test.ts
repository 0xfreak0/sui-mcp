import { describe, it, expect } from "vitest";
import {
  effectiveSetting,
  isPending,
  coinTypeFromKey,
  restrictionNote,
  type CoinRestrictions,
} from "../src/utils/deny-list.js";
import { configKeyBcs, addressKeyBcs } from "../src/utils/deny-list-probe.js";

/**
 * The shape is taken from a real mainnet entry read off 0x403:
 * `{ data: { newer_value_epoch: "566", newer_value: true, older_value_opt: null } }`
 */
const setting = (epoch: number, newer: boolean | null, older: boolean | null = null) => ({
  data: { newer_value_epoch: String(epoch), newer_value: newer, older_value_opt: older },
});

describe("effectiveSetting", () => {
  /**
   * config.move: `if (current_epoch > data.newer_value_epoch) newer else older`.
   * Strictly greater — this is the whole subtlety.
   */
  it("applies a denial only AFTER its epoch, not during it", () => {
    expect(effectiveSetting(setting(566, true), 567)).toBe(true);
    expect(effectiveSetting(setting(566, true), 566)).toBe(null);
    expect(effectiveSetting(setting(566, true), 565)).toBe(null);
  });

  it("falls back to the older value while the newer one is pending", () => {
    expect(effectiveSetting(setting(600, false, true), 600)).toBe(true);
    expect(effectiveSetting(setting(600, false, true), 601)).toBe(false);
  });

  it("reads a long-settled entry as in force", () => {
    // Real mainnet: written at epoch 566, current epoch 1246.
    expect(effectiveSetting(setting(566, true), 1246)).toBe(true);
  });

  it("returns null for a setting with no data", () => {
    expect(effectiveSetting({}, 100)).toBeNull();
    expect(effectiveSetting({ data: null }, 100)).toBeNull();
  });

  it("does not invent an epoch when one is missing", () => {
    expect(effectiveSetting({ data: { newer_value: true } }, 100)).toBe(true);
  });
});

describe("isPending", () => {
  it("flags a change that has not taken effect", () => {
    expect(isPending(setting(600, true), 600)).toBe(true);
    expect(isPending(setting(600, true), 601)).toBe(false);
  });

  it("is not pending when the scheduled value matches the current one", () => {
    expect(isPending(setting(600, true, true), 600)).toBe(false);
  });
});

describe("coinTypeFromKey", () => {
  it("decodes a coin type and restores the 0x prefix", () => {
    // Real key read off 0x403.
    const key = Buffer.from(
      "42434bb7ce79d758da8d29116117efe33bfb3c6a4fdaf58be7e17bf2f57b9f4a::xbtc::XBTC",
    ).toString("base64");
    expect(coinTypeFromKey(key)).toBe(
      "0x42434bb7ce79d758da8d29116117efe33bfb3c6a4fdaf58be7e17bf2f57b9f4a::xbtc::XBTC",
    );
  });

  it("leaves an already-prefixed type alone", () => {
    expect(coinTypeFromKey(Buffer.from("0xa::b::C").toString("base64"))).toBe("0xa::b::C");
  });

  it("rejects anything that is not a type string", () => {
    expect(coinTypeFromKey(Buffer.from("not a type").toString("base64"))).toBeNull();
    expect(coinTypeFromKey("!!!not-base64!!!")).toBeNull();
  });
});

describe("restrictionNote", () => {
  const base: CoinRestrictions = {
    coin_type: "0xa::usdc::USDC",
    config_id: "0xcfg",
    globally_paused: null,
    denied: [],
    truncated: false,
  };

  it("calls a frozen address attribution, and says who can reverse it", () => {
    const n = restrictionNote(
      { ...base, denied: [{ address: "0xbad", active: true }] },
      "0xbad",
    )!;
    expect(n).toMatch(/frozen/i);
    expect(n).toMatch(/DenyCap/);
    expect(n).toMatch(/attribution/i);
  });

  it("distinguishes a recorded-but-not-yet-active entry", () => {
    const n = restrictionNote(
      { ...base, denied: [{ address: "0xbad", active: false }] },
      "0xbad",
    )!;
    expect(n).toMatch(/NOT yet in force/i);
    expect(n).toMatch(/can still transact/i);
  });

  /**
   * A global pause is the issuer acting on the asset, not on a holder.
   * Reporting it as "this address is restricted" would attach a blanket
   * decision to a specific party.
   */
  it("does not read a global pause as being about the address", () => {
    const n = restrictionNote({ ...base, globally_paused: true }, "0xinnocent")!;
    expect(n).toMatch(/globally paused/i);
    expect(n).toMatch(/says nothing about any particular holder/i);
  });

  it("says nothing when the address is not restricted", () => {
    expect(restrictionNote(base, "0xfine")).toBeUndefined();
  });
});

describe("BCS key encoding", () => {
  /**
   * Both encodings are verified against mainnet in
   * `scripts/probe/dyn-keyed.mjs` and `dyn-configkey.mjs`: the ConfigKey below
   * resolves to config 0xf314b4f8… and the AddressKey to a real denial. A wrong
   * encoding returns null, which is indistinguishable from "not denied" — so
   * these are pinned rather than trusted.
   */
  it("encodes ConfigKey as u64 index + length-prefixed type, without 0x", () => {
    const coin =
      "0x20042e47b0169e3c411b053033a48144ba30fde68394c2ddc28b5522c2c42fc8::bluebirdy::BLUEBIRDY";
    const b = Buffer.from(configKeyBcs(coin), "base64");
    expect(b.subarray(0, 8)).toEqual(Buffer.alloc(8)); // COIN_INDEX = 0
    const body = b.subarray(8);
    expect(body[0]).toBe(coin.length - 2); // ULEB length, 0x stripped
    expect(body.subarray(1).toString("utf8")).toBe(coin.slice(2));
    expect(body.subarray(1).toString("utf8").startsWith("0x")).toBe(false);
  });

  it("encodes AddressKey as 32 raw bytes", () => {
    const b = Buffer.from(addressKeyBcs("0x0da83d0a41509fdc91bea1ee7a46d422179571ac4daa5e570c190218d868338b"), "base64");
    expect(b).toHaveLength(32);
    expect(b.toString("hex")).toBe("0da83d0a41509fdc91bea1ee7a46d422179571ac4daa5e570c190218d868338b");
  });

  it("left-pads a short address rather than producing a short key", () => {
    expect(Buffer.from(addressKeyBcs("0x2"), "base64")).toHaveLength(32);
  });
});
