import { describe, it, expect } from "vitest";
import type { GrpcTypes } from "@mysten/sui/grpc";
import { displayCoin, symbolOf } from "../src/utils/valuation.js";
import { formatCoinAmount } from "../src/utils/coin-amount.js";
import { decodeTransaction } from "../src/protocols/decoder.js";

// Real mainnet types from the Cetus attacker's history.
const WORMHOLE_USDC = "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN";
const WORMHOLE_WETH = "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN";
const NATIVE_USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const VAULT_SHARE = `0x5ffa69ee4ee14d899dcc750df92de12bad4bacf81efa1ae12ee76406804dda7f::vault::MagicCoin<${NATIVE_USDC}>`;

describe("coin names", () => {
  /**
   * Regression: the name was the last `::` segment of the type string, so the
   * vault share wrapping USDC was called `USDC>`, and every Wormhole asset,
   * each `<package>::coin::COIN`, was called `COIN`.
   */
  it("keeps a generic coin's own name and names its argument", () => {
    expect(symbolOf(VAULT_SHARE)).toBe("MagicCoin<USDC>");
    expect(symbolOf(`0xabc::lp::LP<${WORMHOLE_USDC}, 0x2::sui::SUI>`)).toBe("LP<USDC, SUI>");
  });

  it("names Wormhole assets by their curated symbol, not the struct name", () => {
    expect(displayCoin(WORMHOLE_USDC).symbol).not.toBe("COIN");
    expect(displayCoin(WORMHOLE_WETH).symbol).not.toBe(displayCoin(WORMHOLE_USDC).symbol);
  });

  it("uses those names in a decoded transaction's token flow", () => {
    const flow = decodeTransaction(
      [],
      [
        { address: "0xa", coinType: WORMHOLE_USDC, amount: "-5" },
        { address: "0xa", coinType: VAULT_SHARE, amount: "5" },
      ] as unknown as GrpcTypes.BalanceChange[],
      "0xa",
    ).token_flow;
    expect(flow.map((f) => f.coin)).toEqual([displayCoin(WORMHOLE_USDC).symbol, "MagicCoin<USDC>"]);
  });
});

describe("formatCoinAmount", () => {
  /**
   * Regression: identify_address showed `sui_balance: "50000000"` for the
   * Cetus attacker, which is 0.05 SUI and reads as fifty million.
   */
  it("puts a raw base-unit amount in human units with its symbol", () => {
    expect(formatCoinAmount("50000000", "0x2::sui::SUI")).toBe("0.05 SUI");
    expect(formatCoinAmount("-5765124463062928", "0x2::sui::SUI")).toBe("-5765124.463062928 SUI");
  });

  it("stays exact beyond 2^53 base units", () => {
    expect(formatCoinAmount("123456789012345678901", "0x2::sui::SUI")).toBe("123456789012.345678901 SUI");
  });

  it("marks a coin nothing vouches for and a guessed scale", () => {
    expect(formatCoinAmount("1000000000", "0xdead::fake::SUI")).toBe("1 SUI (unverified, assumed scale)");
  });

  it("passes a failed read through as null rather than a zero", () => {
    expect(formatCoinAmount(null, "0x2::sui::SUI")).toBeNull();
  });
});
