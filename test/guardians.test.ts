import { describe, expect, it } from "vitest";
import { createGuardiansIndex, guardiansFlagsForCoin, type GuardiansFile } from "../src/utils/guardians.js";
import { runWithNetwork } from "../src/config.js";

// Shaped like scripts/sync-guardians.mjs output. Entries are real
// MystenLabs/wallet_blocklist rows: a blocklisted coin, a blocklisted package
// and the package behind a blocklisted NFT type.
const SCAM_COIN_PKG = "0x001432e94bee3e74bf0a506b873dab34f87c585746381bbbe1951ca57d757c0e";
const SCAM_PKG = "0x00004e50828e5220f8647ad900b5b35c33f5ac40585b516f16f3e5e77ba6a4cf";
const SCAM_NFT_PKG = "0x00004e05b64cf8ac39ca33df3481136726b15f43dbd4a8d379eae34dcba91e63";
const ALLOWED_POSITION = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::position::Position";

const FILE: GuardiansFile = {
  source_url: "https://github.com/MystenLabs/wallet_blocklist",
  commit: "c5bfd72f0a07fe53fa094db211f656ae3667c3f6",
  retrieved_at: "2026-09-25",
  prefix_hex_digits: 16,
  allowlist: { coins: [], packages: [], object_types: [ALLOWED_POSITION] },
  coins: [`${SCAM_COIN_PKG}::MMT6::MMT6`],
  packages: [SCAM_PKG.slice(2, 18)],
  object_type_packages: [SCAM_NFT_PKG.slice(2, 18), ALLOWED_POSITION.slice(2, 18)],
};
const index = createGuardiansIndex(FILE);

describe("guardians index", () => {
  it("flags a blocklisted coin type, whatever padding the caller used", () => {
    const short = `0x1432e94bee3e74bf0a506b873dab34f87c585746381bbbe1951ca57d757c0e::MMT6::MMT6`;
    expect(index.forCoin(short)).toEqual([
      expect.objectContaining({ kind: "coin", tier: "third-party", matched: `${SCAM_COIN_PKG}::MMT6::MMT6` }),
    ]);
  });

  it("does not flag a different coin from an unlisted package", () => {
    expect(index.forCoin("0x2::sui::SUI")).toEqual([]);
  });

  it("flags a package on the package list and one that defines a blocklisted object type", () => {
    expect(index.forPackage(SCAM_PKG).map((f) => f.kind)).toEqual(["package"]);
    expect(index.forPackage(SCAM_NFT_PKG).map((f) => f.kind)).toEqual(["object-type-package"]);
  });

  it("reads the coin inside a Coin<T> object type", () => {
    expect(index.forObjectType(`0x2::coin::Coin<${SCAM_COIN_PKG}::MMT6::MMT6>`).map((f) => f.kind)).toEqual(["coin"]);
  });

  it("lets the allowlist win for an exact object type", () => {
    expect(index.forObjectType(ALLOWED_POSITION)).toEqual([]);
  });

  it("says in every flag that it is not attribution and not a sink", () => {
    expect(index.forPackage(SCAM_PKG)[0]!.note).toMatch(/not attribution.*not a reason to stop a trace/);
  });

  it("reports nothing off mainnet, where package ids name different packages", () => {
    const coin = `${SCAM_COIN_PKG}::MMT6::MMT6`;
    expect(runWithNetwork("mainnet", () => guardiansFlagsForCoin(coin))).toHaveLength(1);
    expect(runWithNetwork("testnet", () => guardiansFlagsForCoin(coin))).toEqual([]);
  });
});
