import { describe, it, expect } from "vitest";
import { decodeTransaction } from "../src/protocols/decoder.js";
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
