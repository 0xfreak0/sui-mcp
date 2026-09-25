import { describe, it, expect } from "vitest";
import fixture from "./fixtures/address-balance-txs.json" with { type: "json" };
import { gasSource, readAddressBalanceOps, readFundsWithdrawals } from "../src/utils/address-balance.js";
import { createdFor, readGrpcObjectChanges, summarizeObjectChanges } from "../src/utils/object-flow.js";

/**
 * Address balances hold funds without any coin object. Every shape below is a
 * real gRPC `GetTransaction` response captured from mainnet; `revive` turns
 * the fixture's `"123n"` strings back into the bigints the client returns.
 */
function revive<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_k, v) =>
    typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  );
}

const withdrawAndSend = revive(fixture["CD2e4GVCjgHjjp9Z52yge5WF2HB52vBpreJGYe4Utiay"]);
const selfSweep = revive(fixture["34q8kUTe8Uoe3f6cD5wKmS7ZqgYg3uX8J7nAJEuGeGTF"]);
const cetusMint = revive(fixture["8eHgw5hBnALFJKPstXWcPgKjeh1av1CzFAz8n85Primr"]);

const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

describe("address-balance writes are not object changes", () => {
  /**
   * CD2e4… redeemed 1951 MIST from the sender's address balance and sent it to
   * another address. Effects list two ACCUMULATOR_WRITE entries and GraphQL
   * `objectChanges` is empty; the count used to say two objects changed.
   */
  it("counts no objects for a transaction that only moved address balances", () => {
    expect(summarizeObjectChanges(withdrawAndSend.changedObjects)).toEqual({
      changed: 0,
      created: 0,
      deleted: 0,
    });
  });

  it("still counts the real coin deleted beside accumulator writes", () => {
    expect(summarizeObjectChanges(selfSweep.changedObjects)).toEqual({
      changed: 1,
      created: 0,
      deleted: 1,
    });
  });
});

describe("address_balance_ops", () => {
  it("reads each accumulator write as a deposit or withdrawal", () => {
    expect(readAddressBalanceOps(withdrawAndSend.changedObjects)).toEqual([
      {
        owner: "0xb71effa1cc4425928e0bda7c3b690a356245e705b01b5380b5d4d1a3497c1d47",
        coin_type: SUI,
        op: "deposit",
        amount: "1951",
      },
      {
        owner: "0x7c8e2ceb0839680a3b1f7aa1021d45670405d92f3c88e79aa1d3aa8a600bbdbf",
        coin_type: SUI,
        op: "withdraw",
        amount: "101951",
      },
    ]);
  });

  /**
   * 34q8k…: the sender's 704,848 SUI gas coin 0x6b0e… was deleted and MERGEd
   * into the same owner's address balance while balance_changes showed only the
   * -100k payment. The deposit is the owner's own coin changing form.
   */
  it("flags a coin folded into its owner's address balance", () => {
    const ops = readAddressBalanceOps(selfSweep.changedObjects);
    const own = ops.find((o) => o.owner === selfSweep.sender)!;
    expect(own).toMatchObject({ op: "deposit", amount: "704848146266530", coin_type: SUI });
    expect(own.converted_from_coins).toEqual([
      "0x6b0e59544cd4d7c161e038fa13b6fb7314f442c1f86d2b0ce55576367469c40e",
    ]);
    expect(own.note).toMatch(/^Coin converted to owner's address balance \(no value moved\)/);

    // The payee received real value; nothing of theirs was deleted.
    const payee = ops.find((o) => o.owner !== selfSweep.sender)!;
    expect(payee).toMatchObject({ op: "deposit", amount: "100000000000000" });
    expect(payee.converted_from_coins).toBeUndefined();
  });

  it("does not flag a deposit when the deleted coin is of another type", () => {
    const changes = selfSweep.changedObjects.map((c: Record<string, unknown>) =>
      c.idOperation === 3 ? { ...c, objectType: "0x2::coin::Coin<0xabc::usdc::USDC>" } : c,
    );
    const own = readAddressBalanceOps(changes).find((o) => o.owner === selfSweep.sender)!;
    expect(own.converted_from_coins).toBeUndefined();
  });

  /** Framework types are matched in full: a look-alike `coin::Coin` is not a coin. */
  it("does not flag a deposit when the deleted object only looks like a coin", () => {
    const changes = selfSweep.changedObjects.map((c: Record<string, unknown>) =>
      c.idOperation === 3 ? { ...c, objectType: `0xabc::coin::Coin<${SUI}>` } : c,
    );
    const own = readAddressBalanceOps(changes).find((o) => o.owner === selfSweep.sender)!;
    expect(own.converted_from_coins).toBeUndefined();
  });
});

describe("funds_withdrawals", () => {
  it("reports the amount, coin type and whose balance a withdrawal draws on", () => {
    expect(readFundsWithdrawals(withdrawAndSend.inputs)).toEqual([
      { amount: "1951", coin_type: SUI, source: "sender" },
    ]);
  });

  it("is empty for a transaction with no withdrawal inputs", () => {
    expect(readFundsWithdrawals(selfSweep.inputs)).toEqual([]);
  });
});

describe("gas source", () => {
  it("reads an empty payment list as gas paid from the address balance", () => {
    expect(gasSource(withdrawAndSend.gasPayment.objects)).toEqual({ source: "address_balance", coins: [] });
  });

  /**
   * 34q8k… lists a version-0 reference whose digest ends in the 0xAC marker
   * beside a real coin. The reference names no object; the coin does.
   */
  it("separates an address-balance reference from a real gas coin", () => {
    expect(gasSource(selfSweep.gasPayment.objects)).toEqual({
      source: "coins_and_address_balance",
      coins: ["0x6b0e59544cd4d7c161e038fa13b6fb7314f442c1f86d2b0ce55576367469c40e"],
    });
  });

  it("reads ordinary gas coins as coins", () => {
    expect(gasSource(cetusMint.gasPayment.objects)).toEqual({
      source: "coins",
      coins: ["0xa72f8f12b4288335d9d1bf1e9bbc71fe84aca4cafb87fa7df12d741c31ab93e3"],
    });
  });
});

describe("created_for", () => {
  /**
   * 8eHgw5…: Cetus's multisig published `message_from_cetus` and minted a
   * `MessageFromCetus` NFT to each exploiter address. The Display, UpgradeCap
   * and Publisher stayed with the sender and are not deliveries.
   */
  it("lists objects minted to someone other than the sender", () => {
    const minted = createdFor(readGrpcObjectChanges(cetusMint.changedObjects), cetusMint.sender);
    expect(minted.map((m) => [m.type_short, m.to])).toEqual([
      [
        "message_from_cetus::MessageFromCetus",
        { kind: "address", address: "0xe28b50cef1d633ea43d3296a3f6b67ff0312a5f1a99f0af753c85b8b5de8ff06" },
      ],
      [
        "message_from_cetus::MessageFromCetus",
        { kind: "address", address: "0xcd8962dad278d8b50fa0f9eb0186bfa4cbdecc6d59377214c88d0286a0ac9562" },
      ],
    ]);
  });

  it("leaves out an object minted to a burn address", () => {
    const burned = cetusMint.changedObjects.map((c: Record<string, unknown>) =>
      c.objectType?.toString().endsWith("MessageFromCetus")
        ? { ...c, outputOwner: { kind: 1, address: `0x${"0".repeat(64)}` } }
        : c,
    );
    expect(createdFor(readGrpcObjectChanges(burned), cetusMint.sender)).toEqual([]);
  });
});
