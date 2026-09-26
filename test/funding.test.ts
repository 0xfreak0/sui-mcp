import { describe, it, expect } from "vitest";
import { pickFundingTx, type FundingTx } from "../src/utils/funding.js";

const TARGET = "0xtarget";
const CEX = "0xcex";
const SUI = "0x2::sui::SUI";

function tx(digest: string, sender: string | null, changes: FundingTx["changes"]): FundingTx {
  return { digest, sender, timestamp: "2024-01-01T00:00:00Z", checkpoint: "1", changes };
}

describe("pickFundingTx", () => {
  it("picks the first tx that funds the target and names the funder (counterparty)", () => {
    const txs = [
      tx("t1", CEX, [
        { address: CEX, amount: "-5000000000", coinType: SUI },
        { address: TARGET, amount: "5000000000", coinType: SUI },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET).funding;
    expect(r?.funder).toBe(CEX);
    expect(r?.amount).toBe("5000000000");
    expect(r?.coinType).toBe(SUI);
    expect(r?.digest).toBe("t1");
  });

  it("skips transactions where the target only sends / nets negative", () => {
    const txs = [
      // target sends out — not a funding event
      tx("out", TARGET, [
        { address: TARGET, amount: "-1000000000", coinType: SUI },
        { address: "0xother", amount: "1000000000", coinType: SUI },
      ]),
      // then a real inbound
      tx("in", CEX, [
        { address: CEX, amount: "-2000000000", coinType: SUI },
        { address: TARGET, amount: "2000000000", coinType: SUI },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET).funding;
    expect(r?.digest).toBe("in");
    expect(r?.funder).toBe(CEX);
  });

  it("falls back to the sender when there's no negative counterparty (e.g. mint/faucet)", () => {
    const txs = [
      tx("mint", "0xfaucet", [{ address: TARGET, amount: "1000000000", coinType: SUI }]),
    ];
    const r = pickFundingTx(txs, TARGET).funding;
    expect(r?.funder).toBe("0xfaucet");
  });

  it("chooses the largest inflow coin by raw amount when no prices are available", () => {
    const OTHER = "0xa::c::OTHER";
    const txs = [
      tx("multi", CEX, [
        { address: CEX, amount: "-100000000", coinType: SUI },
        { address: TARGET, amount: "100000000", coinType: SUI },
        { address: TARGET, amount: "999999", coinType: OTHER },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET).funding;
    // With no price function, ranking falls back to raw magnitude — which is
    // only meaningful within one coin, hence the USD-aware test below.
    expect(r?.coinType).toBe(SUI);
    expect(r?.amount).toBe("100000000");
  });

  it("ranks inflows by USD when prices are available", () => {
    // Raw magnitude ranks by decimal places: 0.1 SUI (1e8 raw) looks "bigger"
    // than 1 OTHER (999999 raw at 6 decimals) purely because SUI has more
    // decimals. With a price function the more valuable inflow wins.
    const OTHER = "0xa::c::OTHER";
    const txs = [
      tx("multi", CEX, [
        { address: CEX, amount: "-100000000", coinType: SUI },
        { address: TARGET, amount: "100000000", coinType: SUI },
        { address: TARGET, amount: "999999", coinType: OTHER },
      ]),
    ];
    const valueUsd = (coinType: string, raw: bigint) =>
      coinType === SUI ? Number(raw) / 1e9 * 0.75 : Number(raw) / 1e6 * 50;
    const r = pickFundingTx(txs, TARGET, { valueUsd }).funding;
    // 0.1 SUI ≈ $0.075 vs ~1 OTHER at $50.
    expect(r?.coinType).toBe(OTHER);
  });

  it("returns null when nothing funds the target", () => {
    const txs = [tx("x", TARGET, [{ address: TARGET, amount: "-1", coinType: SUI }])];
    expect(pickFundingTx(txs, TARGET).funding).toBeNull();
  });
});

describe("pickFundingTx — dust is not funding", () => {
  it("skips a spam-sized SUI send and reports why", () => {
    // 1 MIST is 1e-9 SUI. Gas for a simple transfer is ~0.001-0.005 SUI, so a
    // dust send is orders of magnitude below anything that could fund a
    // wallet. Named as the funder, it would send the funding walk up the
    // spammer's ancestry as the subject's origin.
    const txs = [
      tx("dust", "0xspammer", [
        { address: "0xspammer", amount: "-1", coinType: SUI },
        { address: TARGET, amount: "1", coinType: SUI },
      ]),
      tx("real", CEX, [
        { address: CEX, amount: "-5000000000", coinType: SUI },
        { address: TARGET, amount: "5000000000", coinType: SUI },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET);
    expect(r.funding?.digest).toBe("real");
    expect(r.funding?.funder).toBe(CEX);
    // Skipped, not hidden — silent filtering is how a reader loses evidence.
    expect(r.dustSkipped).toEqual([
      { digest: "dust", amount: "1", coinType: SUI, reason: "below_sui_floor" },
    ]);
  });

  it("treats an unpriced coin as spam regardless of how large the number is", () => {
    // The load-bearing rule, and not a threshold: nobody funds a wallet with a
    // token that has no market. A scam token can mint any quantity it likes.
    const SCAM = "0xbad::airdrop::CLAIM";
    const txs = [
      tx("scam", "0xspammer", [{ address: TARGET, amount: "999999999999999", coinType: SCAM }]),
      tx("real", CEX, [
        { address: CEX, amount: "-5000000000", coinType: SUI },
        { address: TARGET, amount: "5000000000", coinType: SUI },
      ]),
    ];
    const valueUsd = (coinType: string) => (coinType === SUI ? 0.75 : null);
    const r = pickFundingTx(txs, TARGET, { valueUsd });
    expect(r.funding?.digest).toBe("real");
    expect(r.dustSkipped[0]).toMatchObject({ digest: "scam", reason: "unpriced_coin" });
  });

  it("accepts a non-SUI inflow when there is no price oracle at all", () => {
    // Missing prices must not discard evidence — only a *known* lack of market
    // is a spam signal, not an absent dependency.
    const USDC = "0xa::usdc::USDC";
    const txs = [tx("in", CEX, [
      { address: CEX, amount: "-5000000", coinType: USDC },
      { address: TARGET, amount: "5000000", coinType: USDC },
    ])];
    expect(pickFundingTx(txs, TARGET).funding?.digest).toBe("in");
  });

  it("honours caller-supplied floors, for a faucet-scale investigation", () => {
    const txs = [tx("tiny", CEX, [
      { address: CEX, amount: "-1", coinType: SUI },
      { address: TARGET, amount: "1", coinType: SUI },
    ])];
    expect(pickFundingTx(txs, TARGET).funding).toBeNull();
    expect(pickFundingTx(txs, TARGET, { minSuiMist: 0n }).funding?.digest).toBe("tiny");
  });
});

describe("pickFundingTx — an unpriced coin that no airdrop could send counts", () => {
  // A KONG grant to TARGET, then 3 SUI from the deployer. KONG has 1 decimal
  // and a supply of 10B (100,000,000,000 raw), and no price source quotes it.
  const KONG = "0xb0c3::kong::KONG";
  const DEPLOYER = "0xdep";
  const SUPPLY = 100_000_000_000n;
  const valueUsd = (coinType: string) => (coinType === SUI ? 3.5 : null);
  const grantThenGas = (grant: string, from = DEPLOYER) => [
    tx("grant", from, [
      { address: from, amount: `-${grant}`, coinType: KONG },
      { address: TARGET, amount: grant, coinType: KONG },
    ]),
    tx("gas", DEPLOYER, [
      { address: DEPLOYER, amount: "-3001747880", coinType: SUI },
      { address: TARGET, amount: "3000000000", coinType: SUI },
    ]),
  ];

  it("counts an inflow of 1% or more of the coin's supply, and says why", () => {
    const r = pickFundingTx(grantThenGas("10000000000", "0xstranger"), TARGET, {
      valueUsd,
      coinOrigin: () => ({ totalSupply: SUPPLY, publisher: DEPLOYER }),
    });
    expect(r.funding).toMatchObject({ digest: "grant", funder: "0xstranger" });
    expect(r.funding?.unpriced).toEqual({ share_of_supply: 0.1, from_publisher: false });
    expect(r.dustSkipped).toEqual([]);
  });

  it("counts a smaller allocation only when the coin's publisher sent it", () => {
    const half = "500000000"; // 0.5% of supply
    const origin = () => ({ totalSupply: SUPPLY, publisher: DEPLOYER });
    const fromPublisher = pickFundingTx(grantThenGas(half), TARGET, { valueUsd, coinOrigin: origin });
    expect(fromPublisher.funding).toMatchObject({ digest: "grant", unpriced: { from_publisher: true } });
    const fromStranger = pickFundingTx(grantThenGas(half, "0xstranger"), TARGET, { valueUsd, coinOrigin: origin });
    expect(fromStranger.funding?.digest).toBe("gas");
    expect(fromStranger.dustSkipped[0]).toMatchObject({ digest: "grant", reason: "unpriced_coin" });
  });

  it("still skips a publisher's airdrop: a share thousands of wallets could each get", () => {
    // 0.01% each: 10,000 wallets can be sent this much, so it says nothing
    // about who created this one.
    const r = pickFundingTx(grantThenGas("10000000"), TARGET, {
      valueUsd,
      coinOrigin: () => ({ totalSupply: SUPPLY, publisher: DEPLOYER }),
    });
    expect(r.funding?.digest).toBe("gas");
    expect(r.dustSkipped[0]).toMatchObject({ digest: "grant", reason: "unpriced_coin" });
  });

  it("still skips an unpriced coin whose supply the chain does not report", () => {
    const r = pickFundingTx(grantThenGas("10000000000"), TARGET, {
      valueUsd,
      coinOrigin: () => ({ totalSupply: null, publisher: DEPLOYER }),
    });
    expect(r.funding?.digest).toBe("gas");
  });

  describe("a grant bundled with sub-floor SUI in one transaction", () => {
    const LATER = "0x1a7e";
    const bundledThenLater = (grant: string) => [
      tx("bundle", DEPLOYER, [
        { address: DEPLOYER, amount: "-5000000", coinType: SUI },
        { address: TARGET, amount: "5000000", coinType: SUI },
        { address: DEPLOYER, amount: `-${grant}`, coinType: KONG },
        { address: TARGET, amount: grant, coinType: KONG },
      ]),
      tx("later", LATER, [
        { address: LATER, amount: "-3000000000", coinType: SUI },
        { address: TARGET, amount: "3000000000", coinType: SUI },
      ]),
    ];

    it("counts 10% of supply from the publisher although 0.005 SUI rode in the same transaction", () => {
      const r = pickFundingTx(bundledThenLater("10000000000"), TARGET, {
        valueUsd,
        coinOrigin: (t) => (t === KONG ? { totalSupply: SUPPLY, publisher: DEPLOYER } : undefined),
      });
      expect(r.funding).toMatchObject({ digest: "bundle", funder: DEPLOYER, coinType: KONG });
      expect(r.funding?.unpriced).toEqual({ share_of_supply: 0.1, from_publisher: true });
      expect(r.dustSkipped).toEqual([{ digest: "bundle", amount: "5000000", coinType: SUI, reason: "below_sui_floor" }]);
    });

    it("lists both skipped coins of the transaction before the origin is read, so the caller knows to read it", () => {
      const r = pickFundingTx(bundledThenLater("10000000000"), TARGET, { valueUsd });
      expect(r.funding?.digest).toBe("later");
      expect(r.dustSkipped).toEqual([
        { digest: "bundle", amount: "5000000", coinType: SUI, reason: "below_sui_floor" },
        { digest: "bundle", amount: "10000000000", coinType: KONG, reason: "unpriced_coin" },
      ]);
    });

    it("still passes over a publisher's airdrop-sized share bundled with gas money", () => {
      const r = pickFundingTx(bundledThenLater("10000000"), TARGET, {
        valueUsd,
        coinOrigin: () => ({ totalSupply: SUPPLY, publisher: DEPLOYER }),
      });
      expect(r.funding?.digest).toBe("later");
    });
  });
});

describe("pickFundingTx — the funder must have sent what arrived", () => {
  it("does not attribute a sponsored transfer to the gas payer", () => {
    // Gas is folded into the payer's net SUI rather than itemised, so a
    // sponsor's -0.036 SUI (raw -36000000) outranks a real sender's -11 USDC
    // (raw -11085939) purely because SUI has three more decimals. Comparing
    // across all coins named the sponsor as the funder.
    const USDC = "0xa::usdc::USDC";
    const SPONSOR = "0xsponsor";
    const SENDER = "0xrealsender";
    const txs = [
      tx("sponsored", SPONSOR, [
        { address: SPONSOR, amount: "-36000000", coinType: SUI },
        { address: SENDER, amount: "-11085939", coinType: USDC },
        { address: TARGET, amount: "11085939", coinType: USDC },
      ]),
    ];
    const r = pickFundingTx(txs, TARGET).funding;
    expect(r?.coinType).toBe(USDC);
    expect(r?.funder).toBe(SENDER);
    expect(r?.funder).not.toBe(SPONSOR);
  });

  it("falls back to any negative counterparty when nobody sent the received coin", () => {
    // A mint or bridge release has no counterparty losing that coin; naming
    // someone beats reporting "unknown".
    const MINTED = "0xa::c::MINTED";
    const txs = [
      tx("mint", "0xminter", [
        { address: "0xminter", amount: "-5000000000", coinType: SUI },
        { address: TARGET, amount: "1000000", coinType: MINTED },
      ]),
    ];
    expect(pickFundingTx(txs, TARGET).funding?.funder).toBe("0xminter");
  });
});

describe("pickFundingTx — a dead end still says what it saw", () => {
  // The shape of a mainnet relay wallet that pays gas from its operator's
  // address balance: every inflow is ~1,900 MIST from the operator, and every
  // transaction it sends has the operator as gas sponsor. Nothing clears the
  // 0.01 SUI floor, so there is no funding, and the evidence is in the skipped
  // inflows and the sponsor.
  const OPERATOR = "0xoperator";
  const PAYEE = "0xpayee";
  const inflow = (digest: string, amount: string) =>
    ({ ...tx(digest, OPERATOR, [
      { address: OPERATOR, amount: `-${100000 + Number(amount)}`, coinType: SUI },
      { address: TARGET, amount, coinType: SUI },
    ]), gasSponsor: OPERATOR });
  const relay = (digest: string, amount: string) =>
    ({ ...tx(digest, TARGET, [
      { address: PAYEE, amount, coinType: SUI },
      { address: OPERATOR, amount: "-100000", coinType: SUI },
      { address: TARGET, amount: `-${amount}`, coinType: SUI },
    ]), gasSponsor: OPERATOR });
  const txs: FundingTx[] = [
    inflow("FS8u6Lub", "1847"),
    relay("D7VqRJxX", "1847"),
    inflow("14MmbE4g", "1987"),
    relay("ELssxy2E", "1987"),
  ];

  it("keeps the skipped inflows when nothing qualifies", () => {
    const r = pickFundingTx(txs, TARGET);
    expect(r.funding).toBeNull();
    expect(r.dustSkipped.map((d) => [d.digest, d.amount, d.reason])).toEqual([
      ["FS8u6Lub", "1847", "below_sui_floor"],
      ["14MmbE4g", "1987", "below_sui_floor"],
    ]);
  });

  it("names who paid the gas of the transactions the address sent", () => {
    const r = pickFundingTx(txs, TARGET);
    expect(r.sponsors).toEqual([{ sponsor: OPERATOR, transactions: 2, first_digest: "D7VqRJxX" }]);
  });

  it("does not count self-paid gas, or gas on transactions someone else sent, as sponsorship", () => {
    const own = { ...tx("own", TARGET, [{ address: TARGET, amount: "-1000", coinType: SUI }]), gasSponsor: TARGET };
    // The operator's own inflow transactions carry the operator as gas payer
    // too; the address did not send them, so they say nothing about who runs it.
    const r = pickFundingTx([inflow("FS8u6Lub", "1847"), own], TARGET);
    expect(r.sponsors).toEqual([]);
  });
});
