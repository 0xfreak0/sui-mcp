import { describe, it, expect } from "vitest";
import { effectsPayouts } from "../src/utils/payouts.js";
import { readGrpcObjectChanges, type GrpcChangedObject } from "../src/utils/object-flow.js";

const SENDER = `0xaa${"1".repeat(62)}`;
const STRANGER = `0xbb${"2".repeat(62)}`;
const POOL = `0xcc${"3".repeat(62)}`;
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const USDC = `0xdd${"4".repeat(62)}::usdc::USDC`;

/** gRPC owner kinds: 1 address, 2 object. */
const change = (id: string, type: string, from: { kind: number; address: string } | null, to: { kind: number; address: string }, created = false): GrpcChangedObject => ({
  objectId: id,
  objectType: type,
  inputState: created ? 1 : 2,
  idOperation: created ? 2 : 1,
  inputOwner: from,
  outputOwner: to,
});

describe("effectsPayouts", () => {
  it("pays out a coin the sender lost that another address gained, capped at the sender's loss", () => {
    const { payouts, gainers } = effectsPayouts(
      SENDER,
      [
        { address: SENDER, coinType: SUI, amount: "-700" },
        { address: STRANGER, coinType: SUI, amount: "1000" },
      ],
      [],
    );
    expect(payouts).toEqual([{ to: STRANGER, coin_type: SUI, amount: "700" }]);
    expect([...gainers]).toEqual([STRANGER]);
  });

  it("counts a coin another address gained that the sender did not lose as a gain, not a payout", () => {
    const { payouts, gainers } = effectsPayouts(
      SENDER,
      [
        { address: SENDER, coinType: SUI, amount: "-10" },
        { address: STRANGER, coinType: USDC, amount: "5000" },
      ],
      [],
    );
    expect(payouts).toEqual([]);
    expect(gainers.has(STRANGER)).toBe(true);
  });

  it("pays out an object that left the sender for another address, whichever function moved it", () => {
    const movements = readGrpcObjectChanges([change("0x0101", `${POOL}::nft::Hero`, { kind: 1, address: SENDER }, { kind: 1, address: STRANGER })]);
    expect(effectsPayouts(SENDER, [], movements).payouts).toEqual([{ to: STRANGER, object_id: "0x0101", object_type: `${POOL}::nft::Hero` }]);
  });

  it("does not read an object moved into the sender's own kiosk, or one created for someone else, as the sender's payout", () => {
    const movements = readGrpcObjectChanges([
      change("0x0101", `${POOL}::nft::Hero`, { kind: 1, address: SENDER }, { kind: 2, address: POOL }),
      change("0x0202", `${POOL}::nft::Ticket`, null, { kind: 1, address: STRANGER }, true),
    ]);
    const { payouts, gainers } = effectsPayouts(SENDER, [], movements);
    expect(payouts).toEqual([]);
    expect([...gainers]).toEqual([STRANGER]);
  });

  it("takes the gas the sender paid out of its SUI change, so a sender that only paid gas lost nothing and paid nobody", () => {
    const changes = [
      { address: SENDER, coinType: SUI, amount: "-1500" },
      { address: STRANGER, coinType: SUI, amount: "900" },
    ];
    const withoutGas = effectsPayouts(SENDER, changes, []);
    expect(withoutGas.sender_lost).toBe(true);
    expect(withoutGas.payouts).toHaveLength(1);
    const gasOnly = effectsPayouts(SENDER, changes, [], { payer: SENDER, net: 1500n });
    expect(gasOnly.sender_lost).toBe(false);
    expect(gasOnly.payouts).toEqual([]);
  });

  it("reads a swap as lost and received, and an object handed away with nothing back as lost only", () => {
    const swap = effectsPayouts(
      SENDER,
      [
        { address: SENDER, coinType: SUI, amount: "-1000" },
        { address: SENDER, coinType: USDC, amount: "700" },
      ],
      [],
      { payer: SENDER, net: 0n },
    );
    expect([swap.sender_lost, swap.sender_received]).toEqual([true, true]);
    const handedAway = effectsPayouts(SENDER, [], readGrpcObjectChanges([change("0x0303", `${POOL}::nft::Hero`, { kind: 1, address: SENDER }, { kind: 2, address: POOL })]));
    expect([handedAway.sender_lost, handedAway.sender_received]).toEqual([true, false]);
  });

  it("counts an object created for the sender as received", () => {
    const minted = effectsPayouts(SENDER, [], readGrpcObjectChanges([change("0x0404", `${POOL}::position::Position`, null, { kind: 1, address: SENDER }, true)]));
    expect(minted.sender_received).toBe(true);
  });
});
