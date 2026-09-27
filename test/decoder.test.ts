import { describe, it, expect } from "vitest";
import { addressFlow, decodeTransaction } from "../src/protocols/decoder.js";
import type { GrpcTypes } from "@mysten/sui/grpc";

function makeCommand(
  pkg: string,
  mod: string,
  fn: string,
  typeArgs: string[] = []
): GrpcTypes.Command {
  return {
    command: {
      oneofKind: "moveCall",
      moveCall: {
        package: pkg,
        module: mod,
        function: fn,
        typeArguments: typeArgs,
      },
    },
  } as unknown as GrpcTypes.Command;
}

function makeTransferCommand(): GrpcTypes.Command {
  return {
    command: {
      oneofKind: "transferObjects",
      transferObjects: {},
    },
  } as unknown as GrpcTypes.Command;
}

function makeBalanceChange(
  address: string,
  coinType: string,
  amount: string
): GrpcTypes.BalanceChange {
  return { address, coinType, amount } as unknown as GrpcTypes.BalanceChange;
}

describe("decodeTransaction", () => {
  it("decodes a simple Cetus swap", () => {
    const commands = [
      makeCommand(
        "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb",
        "pool",
        "swap_a2b",
        ["0x2::sui::SUI", "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"]
      ),
    ];
    const result = decodeTransaction(commands, [], "0xsender");

    expect(result.protocols).toContain("Cetus");
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toContain("Swap");
    expect(result.actions[0]).toContain("SUI");
    expect(result.actions[0]).toContain("USDC");
    expect(result.actions[0]).toContain("Cetus");
  });

  it("skips infrastructure operations", () => {
    const commands = [
      makeCommand("0x2", "coin", "from_balance"),
      makeCommand("0x2", "coin", "into_balance"),
    ];
    const result = decodeTransaction(commands, [], "0xsender");

    expect(result.actions).toHaveLength(0);
    expect(result.protocols).toContain("Sui Framework");
  });

  it("decodes transferObjects command", () => {
    const commands = [makeTransferCommand()];
    const result = decodeTransaction(commands, [], "0xsender");

    expect(result.actions).toEqual(["Transfer to recipient"]);
  });

  it("decodes unknown package with abbreviated address", () => {
    const commands = [
      makeCommand("0xabcdef1234567890abcdef1234567890", "mymod", "myfn"),
    ];
    const result = decodeTransaction(commands, [], "0xsender");

    expect(result.protocols).toHaveLength(0);
    expect(result.actions[0]).toContain("Call");
    expect(result.actions[0]).toContain("mymod::myfn");
  });

  it("reads Cetus's add, its pay-amount getter and its repayment as one add, and a flash swap's getter as no swap", () => {
    // The call sequence of DVMG3B2k…, one liquidity add paid through its receipt.
    const CETUS = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
    const pair = ["0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI", "0x2::sui::SUI"];
    const commands = [
      makeCommand(CETUS, "pool", "flash_swap", pair),
      makeCommand(CETUS, "pool", "swap_pay_amount", pair),
      makeCommand(CETUS, "pool", "open_position", pair),
      makeCommand(CETUS, "pool", "add_liquidity", pair),
      makeCommand(CETUS, "pool", "remove_liquidity", pair),
      makeCommand(CETUS, "pool", "repay_flash_swap", pair),
      makeCommand(CETUS, "pool", "add_liquidity_pay_amount", pair),
      makeCommand(CETUS, "pool", "repay_add_liquidity", pair),
    ];
    const { actions } = decodeTransaction(commands, [], "0xsender");
    expect(actions.filter((a) => /add liquidity/i.test(a))).toHaveLength(1);
    expect(actions.filter((a) => /^swap/i.test(a))).toHaveLength(0);
  });

  it("captures sender token flow from balance changes", () => {
    const sender = "0xsender";
    const balanceChanges = [
      makeBalanceChange(sender, "0x2::sui::SUI", "-1000000000"),
      makeBalanceChange(sender, "0xdba::usdc::USDC", "500000"),
      makeBalanceChange("0xother", "0x2::sui::SUI", "1000000000"),
    ];
    const result = decodeTransaction([], balanceChanges, sender);

    // Only sender's balance changes appear in token_flow
    expect(result.token_flow).toHaveLength(2);
    expect(result.token_flow[0].coin).toBe("SUI");
    expect(result.token_flow[0].amount).toBe("-1000000000");
    expect(result.token_flow[1].coin).toBe("USDC");
    expect(result.token_flow[1].amount).toBe("500000");
  });

  it("handles empty commands and balance changes", () => {
    const result = decodeTransaction([], undefined, undefined);
    expect(result.protocols).toEqual([]);
    expect(result.actions).toEqual([]);
    expect(result.token_flow).toEqual([]);
  });

  it("decodes Suilend deposit", () => {
    const commands = [
      makeCommand(
        "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf",
        "lending_market",
        "deposit_liquidity",
        ["0x2::sui::SUI"]
      ),
    ];
    const result = decodeTransaction(commands, [], "0xsender");

    expect(result.protocols).toContain("Suilend");
    expect(result.actions[0]).toContain("Deposit");
    expect(result.actions[0]).toContain("SUI");
    expect(result.actions[0]).toContain("Suilend");
  });

  /**
   * Modelled on transaction 22hwJmHj…, where the sender swapped ETH for
   * USDC. Cetus's aggregator wrapper and the underlying pool::swap call carry
   * the same two coins in opposite typeArguments order for one swap, because
   * atob is a runtime argument that typeArguments order does not encode. The
   * sender's own balance changes give the direction, so both calls read
   * "Swap ETH → USDC".
   */
  it("keeps a swap's direction when a second call's typeArguments run opposite the first", () => {
    const ETH = "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH";
    const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
    const sender = "0xsender";
    const commands = [
      makeCommand("0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb", "pool", "swap_a2b", [ETH, USDC]),
      makeCommand("0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb", "pool", "swap_a2b", [USDC, ETH]),
    ];
    const balanceChanges = [
      makeBalanceChange(sender, ETH, "-3222700000"),
      makeBalanceChange(sender, USDC, "130233551351"),
    ];
    const result = decodeTransaction(commands, balanceChanges, sender);

    expect(result.actions).toHaveLength(2);
    for (const action of result.actions) {
      expect(action).toContain("Swap ETH");
      expect(action).not.toContain("Swap USDC");
    }
  });


  /**
   * A deleverage with a top-up: withdraw 100 ETH of collateral, swap 60 ETH
   * for 50 USDC (already in the right order, since the call itself is named
   * `swap_a2b`), then repay 80 USDC (30 of it from the wallet). The
   * sender's PTB-wide net is ETH +40, USDC −30: positive in the swap's
   * first coin and negative in its second, which reads as the reverse of
   * the call's direction. The withdraw/repay legs move the same two coins
   * the swap does, so the net cannot be trusted for this swap's direction
   * and the call's own `swap_a2b` name decides it.
   */
  it("does not flip an already-correct swap from a PTB-wide net polluted by a withdraw/repay leg", () => {
    const ETH = "0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH";
    const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
    const sender = "0xsender";
    const commands = [
      makeCommand("0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf", "lending", "withdraw_collateral", [ETH]),
      makeCommand("0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb", "pool", "swap_a2b", [ETH, USDC]),
      makeCommand("0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf", "lending", "repay_loan", [USDC]),
    ];
    const balanceChanges = [
      makeBalanceChange(sender, ETH, "40000000000"),
      makeBalanceChange(sender, USDC, "-30000000"),
    ];
    const result = decodeTransaction(commands, balanceChanges, sender);

    const swapAction = result.actions.find((a) => a.startsWith("Swap"));
    expect(swapAction).toContain("Swap ETH");
    expect(swapAction).not.toContain("Swap USDC");
  });

  /**
   * Commands of transaction 62MTsGpC… as GraphQL returns them:
   * `adaptCommands` leaves typeArguments empty, and the route calls Bluefin
   * and Cetus `swap_b2a`. With no pair of type arguments, the function name
   * has nothing to reorder and the swap decodes without coins.
   */
  it("decodes a b2a swap call that carries no type arguments", () => {
    const commands = [
      makeCommand("0xe450c157978058fc23078941924ad91bfe3022db6243ffa432f7209ad5bc9889", "bluefin", "swap_b2a"),
      makeCommand("0x579083167575c19912d9f6040e9c4664006cb372dba138ab62330b770165b81a", "cetus", "swap_b2a"),
    ];
    const result = decodeTransaction(commands, [], "0xsender");
    expect(result.actions).toHaveLength(2);
    // Cetus `swap_b2a` is a known swap; with no coins to name it reads bare.
    expect(result.actions[1]).toBe("Swap");
  });

  describe("a polluting leg only distrusts the net of swaps sharing its coins", () => {
    const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
    const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
    const USDT = "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN";
    const KONG = "0x1a5ea2d5d2d1a1e5b5e1fe4bd71fbbd0cd81b4a34a1c1a4e0c8aa3e1e9f0a1b2::kong::KONG";
    const FEE = "0x91bfbc386a41afcfd9b2533058d7e915a1d3829089cc268ff4333d54d6339ca1::fee3000bps::FEE3000BPS";
    const CETUS = "0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb";
    const TURBOS = "0x1a3c42ded7b75cdf4ebc7c7b7da9d1e1db49f16fcdca934fac003f35f39ecad9";
    const DEEPBOOK = "0x2c8d603bc51326b8c13cef9dd07031a408a48dddb541963357661df5d3204809";
    const LENDER = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
    const sender = "0xsender";

    /**
     * Cetus `router::swap` takes a2b as a runtime bool, so neither the name
     * nor the type order says which way it ran; the net is the only signal.
     * An unrelated USDT withdraw beside it leaves that net trusted.
     */
    it("keeps the net for a swap whose coins an unrelated leg does not name", () => {
      const swap = makeCommand(CETUS, "router", "swap", [USDC, SUI]);
      const changes = [makeBalanceChange(sender, SUI, "-10000000000"), makeBalanceChange(sender, USDC, "35000000")];
      expect(decodeTransaction([swap], changes, sender).actions[0]).toMatch(/^Swap SUI → USDC/);

      const withdraw = makeCommand(LENDER, "lending", "withdraw", [USDT]);
      const result = decodeTransaction([withdraw, swap], [...changes, makeBalanceChange(sender, USDT, "100000000")], sender);
      expect(result.actions.find((a) => a.startsWith("Swap"))).toMatch(/^Swap SUI → USDC/);
    });

    /** Turbos `swap_b_a<SUI, KONG, FEE>` paid in KONG reads "KONG → SUI" beside an unrelated USDT deposit. */
    it("keeps a Turbos swap_b_a the right way round beside an unrelated deposit", () => {
      const deposit = makeCommand(LENDER, "lending", "deposit", [USDT]);
      const swap = makeCommand(TURBOS, "swap_router", "swap_b_a", [SUI, KONG, FEE]);
      const changes = [
        makeBalanceChange(sender, KONG, "-5000000000000"),
        makeBalanceChange(sender, SUI, "4000000000"),
        makeBalanceChange(sender, USDT, "-100000000"),
      ];
      expect(decodeTransaction([deposit, swap], changes, sender).actions.find((a) => a.startsWith("Swap"))).toMatch(/^Swap KONG → SUI/);
    });

    /** When a leg does name a swap's coin, the name has to carry the direction on its own. */
    it("reads Turbos swap_b_a and DeepBook quote_for_base from the name when the net is polluted", () => {
      const turbos = decodeTransaction(
        [makeCommand(LENDER, "lending", "withdraw", [SUI]), makeCommand(TURBOS, "swap_router", "swap_b_a_with_return_", [SUI, KONG, FEE])],
        [makeBalanceChange(sender, SUI, "9000000000"), makeBalanceChange(sender, KONG, "-1")],
        sender,
      );
      expect(turbos.actions.find((a) => a.startsWith("Swap"))).toMatch(/^Swap KONG → SUI/);

      const deepbookQuoteIn = decodeTransaction(
        [makeCommand(LENDER, "lending", "repay", [USDC]), makeCommand(DEEPBOOK, "pool", "swap_exact_quote_for_base_with_manager", [SUI, USDC])],
        [],
        sender,
      );
      expect(deepbookQuoteIn.actions.find((a) => a.startsWith("Swap"))).toMatch(/^Swap USDC → SUI/);
      const deepbookBaseIn = decodeTransaction([makeCommand(DEEPBOOK, "pool", "swap_exact_base_for_quote", [SUI, USDC])], [], sender);
      expect(deepbookBaseIn.actions[0]).toMatch(/^Swap SUI → USDC/);
    });

    /**
     * Turbos's multi-hop functions already put the input coin first and a fee
     * type second (`swap_b_a_b_c(Pool<$2, $0, $1>, …, Coin<$0>)`), so their
     * `_b_a` prefix must not reverse the order.
     */
    it("does not read a direction into a Turbos multi-hop name", () => {
      const result = decodeTransaction([makeCommand(TURBOS, "swap_router", "swap_b_a_b_c", [KONG, FEE, SUI, FEE, USDC])], [], sender);
      expect(result.actions[0]).toMatch(/^Swap KONG → /);
    });

    /** A leg with no type arguments may move any coin, so it still distrusts every swap's net. */
    it("distrusts the net beside a polluting leg that names no coin", () => {
      const result = decodeTransaction(
        [makeCommand(LENDER, "lending", "withdraw", []), makeCommand(CETUS, "pool", "swap_a2b", [SUI, USDC])],
        [makeBalanceChange(sender, SUI, "5"), makeBalanceChange(sender, USDC, "-5")],
        sender,
      );
      expect(result.actions.find((a) => a.startsWith("Swap"))).toMatch(/^Swap SUI → USDC/);
    });

    /**
     * The flow engine decodes commands read without their type arguments.
     * A `swap_b_a_with_return_` call with none has no pair to reorder, so it
     * decodes as a bare swap and formatAction is never handed undefined
     * coins.
     */
    it("leaves a direction-named swap with no type arguments unordered", () => {
      for (const fn of ["swap_b_a_with_return_", "swap_exact_quote_for_base", "swap_b2a"]) {
        const result = decodeTransaction([makeCommand(TURBOS, "swap_router", fn, [])], [], sender);
        expect(result.actions[0]).toMatch(/^Swap( on .+)?$/);
      }
      const one = decodeTransaction([makeCommand(TURBOS, "swap_router", "swap_b_a", [SUI])], [], sender);
      expect(one.actions[0]).toMatch(/^Swap( on .+)?$/);
    });
  });
});

describe("addressFlow", () => {
  // FjkAurXTGnmq…: 0x1f7b27 sends ATTACKER 39.44771725 SUI. The sender-side
  // token_flow shows -39449215130, the sender's outflow, on that same row.
  const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
  const ATTACKER = "0x01229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724";
  const SENDER = "0x1f7b27844f2c4a0262b2c481f7ab956d10ace524c5a7b06c3742cfb8701db714";
  const changes = [
    makeBalanceChange(ATTACKER, SUI, "39447717250"),
    makeBalanceChange(SENDER, SUI, "-39449215130"),
  ];

  it("gives the recipient its inflow, not the sender's outflow", () => {
    expect(addressFlow(changes, ATTACKER)).toEqual([
      {
        coin: "SUI",
        amount: "39447717250",
        formatted: "39.44771725 SUI",
        raw_type: SUI,
        coin_verified: true,
      },
    ]);
    expect(decodeTransaction([], changes, SENDER).token_flow[0].amount).toBe("-39449215130");
  });

  it("gives the sender its outflow, signed", () => {
    const [flow] = addressFlow(changes, SENDER);
    expect(flow.amount).toBe("-39449215130");
    expect(flow.formatted).toBe("-39.44921513 SUI");
  });

  it("matches an address written without its leading zero", () => {
    expect(addressFlow(changes, "0x1229b3cc8469779d42d59cfc18141e4b13566b581787bf16eb5d61058c1c724")[0].amount).toBe(
      "39447717250",
    );
  });

  it("nets several changes in one coin and drops a net of zero", () => {
    const flows = addressFlow(
      [
        makeBalanceChange(ATTACKER, SUI, "5"),
        makeBalanceChange(ATTACKER, SUI, "-5"),
        makeBalanceChange(ATTACKER, "0xdead::sui::SUI", "3000000000"),
        makeBalanceChange(ATTACKER, "0xdead::sui::SUI", "-1000000000"),
      ],
      ATTACKER,
    );
    expect(flows).toHaveLength(1);
    expect(flows[0].amount).toBe("2000000000");
  });

  it("marks a coin nothing vouches for, and how its amount was scaled", () => {
    const [flow] = addressFlow([makeBalanceChange(ATTACKER, "0xdead::sui::SUI", "2000000000")], ATTACKER);
    expect(flow.coin_verified).toBe(false);
    expect(flow.coin_scale).toBe("assumed");
    expect(flow.formatted).toContain("unverified");
  });

  it("is empty for an address with no balance change", () => {
    expect(addressFlow(changes, "0x7c8e2ceb0839680a3b1f7aa1021d45670405d92f3c88e79aa1d3aa8a600bbdbf")).toEqual([]);
  });
});
