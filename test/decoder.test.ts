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
});

describe("addressFlow", () => {
  // FjkAurXTGnmq…: 0x1f7b27 sent the Nemo attacker 39.44771725 SUI. The
  // sender-side token_flow reads -39449215130 on the attacker's own row.
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
