/* Raw-chain comparisons for oracle-pass. No production helper is imported here. */
const SUI = `0x${"2".padStart(64, "0")}::sui::SUI`;
const norm = (a) => `0x${String(a).replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
const STAKE_UNSTAKE = `${norm("0x3")}::validator::UnstakingRequestEvent`;
const BRIDGE_DEPOSIT = `${norm("0xb")}::bridge::TokenDepositedEvent`;
const coinType = (t) => String(t).replace(/(^|[<,\s])(?:0x)?([0-9a-fA-F]{1,64})(?=::)/g, (_, p, h) => `${p}0x${h.toLowerCase().padStart(64, "0")}`).replace(/,\s*/g, ", ");
const errText = (e) => String(e?.message ?? e).slice(0, 300);
const balanceField = (t) => `0x2::dynamic_field::Field<0x2::accumulator::Key<0x2::balance::Balance<${t}>>,0x2::accumulator::U128>`;

export function extraOracles({ gql, grpc, rawTx, callTool, answerOf, truthOf, record, skip }) {
  // The earliest affected-address index locates the first transactions.
  // Read each transaction's full balance changes independently of funding.
  // Price and metadata are read directly from their sources, never through
  // the funding tool's helper. Unpriced coins may qualify by supply or send
  // shape; leave those ambiguous rather than assert the SUI payer was first.
  async function funding(key, address) {
    const a = norm(address);
    const subject = `funding ${a}`;
    const data = await truthOf("g", key, subject, async () => {
      const d = await gql(`query($a:SuiAddress!){ transactions(filter:{affectedAddress:$a},first:12){ nodes{digest} pageInfo{hasNextPage} } }`, { a });
      const transactions = [];
      for (const n of d.transactions.nodes) transactions.push(await rawTx(n.digest));
      const types = [...new Set(transactions.flatMap((tx) => tx.balances.filter((c) => c.owner === a && c.amount > 0n && c.coin !== SUI).map((c) => c.coin)))];
      if (!types.length) return { transactions, prices: new Map(), decimals: new Map() };
      if (types.length > 25) return { tooManyTypes: types.length };
      const response = await fetch("https://aftermath.finance/api/price-info", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coins: [SUI, ...types] }), signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`funding price read returned ${response.status}`);
      const quotes = await response.json();
      const prices = new Map(Object.entries(quotes).filter(([, value]) => typeof value?.price === "number" && value.price >= 0).map(([type, value]) => [type, value.price]));
      const decimals = new Map();
      for (const type of types) {
        if (!prices.has(type)) continue;
        const { response: coin } = await grpc.stateService.getCoinInfo({ coinType: type });
        decimals.set(type, coin.metadata?.decimals ?? null);
      }
      return { transactions, prices, decimals };
    });
    if (!data) return;
    if (data.tooManyTypes) return skip("g", key, subject, `first transactions carry ${data.tooManyTypes} coin types, past the price bound`);
    if (data.transactions.some((tx) => tx.balances.some((c) => c.owner === a && c.amount > 0n && c.coin !== SUI)) && !data.prices.has(SUI))
      return skip("g", key, subject, "price service did not quote SUI, so non-SUI funding is unresolved");
    let expected = null;
    for (const tx of data.transactions) {
      const incomes = tx.balances.filter((c) => c.owner === a && c.amount > 0n);
      const ranked = [];
      for (const income of incomes) {
        if (income.coin === SUI) {
          if (income.amount < 10_000_000n) continue;
          ranked.push({ income, usd: data.prices.has(SUI) ? Number(income.amount) * data.prices.get(SUI) / 1e9 : null });
          continue;
        }
        if (!data.prices.has(income.coin)) return skip("g", key, subject, `unpriced ${income.coin} may qualify by supply or send shape`);
        const scale = data.decimals.get(income.coin);
        if (!Number.isInteger(scale)) return skip("g", key, subject, `decimals unavailable for ${income.coin}`);
        const usd = Number(income.amount) * data.prices.get(income.coin) / 10 ** scale;
        if (!Number.isFinite(usd) || (usd >= 0.09 && usd <= 0.11)) return skip("g", key, subject, `ambiguous value near the $0.10 floor for ${income.coin}`);
        if (usd >= 0.10) ranked.push({ income, usd });
      }
      if (!ranked.length) continue;
      if (ranked.length > 1 && ranked.some((r) => r.usd === null))
        return skip("g", key, subject, "SUI quote unavailable to rank multiple inflows in one transaction");
      ranked.sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
      if (ranked.length > 1 && ranked[1].usd >= ranked[0].usd * 0.95)
        return skip("g", key, subject, "competing inflows are too close in value for separate live price reads");
      const selected = ranked[0].income;
      const sent = tx.balances.filter((c) => c.coin === selected.coin && c.owner !== a && c.amount < 0n).sort((x, y) => x.amount < y.amount ? -1 : x.amount > y.amount ? 1 : 0);
      if (!sent.length) return skip("g", key, subject, "qualifying inflow has no recorded negative counterparty");
      if (sent.length > 1 && sent[0].amount === sent[1].amount) return skip("g", key, subject, "equal debits do not identify a unique funder");
      expected = { funding_tx: tx.digest, funded_by: sent[0].owner };
      break;
    }
    if (!expected) return skip("g", key, subject, "no qualifying priced inflow in the first twelve transactions");
    const ours = answerOf("g", key, subject, await callTool("find_funding_source", { address: a, max_hops: 1, measure_fanout: false }));
    if (!ours) return;
    if (ours.incomplete_balance_changes?.length || ours.prices_unavailable_at?.length || ours.origin_unread_at?.length)
      return skip("g", key, subject, "funding judgement reports incomplete chain reads or prices");
    const hop = ours.chain?.[0];
    const observed = hop ? { funding_tx: hop.funding_tx, funded_by: norm(hop.funded_by) } : null;
    record("g", key, subject, observed?.funding_tx === expected.funding_tx && observed.funded_by === expected.funded_by ? "agree" : "disagree",
      { ours: observed, truth: expected, problems: observed?.funding_tx === expected.funding_tx && observed?.funded_by === expected.funded_by ? [] : [{ observed, expected }] });
  }

  // Enumerate both independent object types to completion. No ranking from
  // this service, only amounts and owners, sorted locally after both walks.
  async function holderWalk(type, max = 250) {
    const amounts = new Map();
    const tally = (address, coin, addressBalance) => {
      if (!address || !/^\d+$/.test(String(coin))) throw new Error("holder has no owner or amount");
      const id = norm(address);
      const r = amounts.get(id) ?? { coin: 0n, address: 0n };
      r[addressBalance ? "address" : "coin"] += BigInt(coin);
      amounts.set(id, r);
    };
    let total = 0;
    for (const [filter, isBalance] of [[`0x2::coin::Coin<${type}>`, false], [balanceField(type), true]]) {
      let after = null;
      for (; ;) {
        const d = await gql(`query($t:String!,$a:String){ objects(filter:{type:$t},first:50,after:$a){ nodes{ owner{... on AddressOwner{address{address}} ... on ConsensusAddressOwner{address{address}}} asMoveObject{contents{json}} } pageInfo{hasNextPage endCursor} } }`, { t: filter, a: after });
        for (const o of d.objects.nodes) {
          const j = o.asMoveObject?.contents?.json;
          if (isBalance) tally(j?.name?.address, j?.value?.value, true);
          else tally(o.owner?.address?.address, j?.balance, false);
          if (++total > max) return { tooMany: total };
        }
        if (!d.objects.pageInfo.hasNextPage) break;
        after = d.objects.pageInfo.endCursor;
        if (!after) throw new Error("holder connection has more rows but no cursor");
      }
    }
    return { amounts, total };
  }
  async function holders(key, type) {
    const t = coinType(type), subject = `holders ${t}`;
    const chain = await truthOf("h", key, subject, () => holderWalk(t));
    if (!chain) return;
    if (chain.tooMany) return skip("h", key, subject, `${chain.tooMany} objects already exceed the 250-object independent walk bound`);
    if (!chain.total) return skip("h", key, subject, "coin has no held Coin<T> objects or address balances");
    const ours = answerOf("h", key, subject, await callTool("get_top_holders", { type: t, mode: "token", max_scan: 300, limit: 50 }));
    if (!ours) return;
    if (!ours.complete_ranking || ours.unresolved_owners || ours.omitted?.lists?.top_holders)
      return skip("h", key, subject, "tool says the walk or ownership is incomplete");
    const sorted = [...chain.amounts].sort(([a, x], [b, y]) => {
      const ax = x.coin + x.address, by = y.coin + y.address;
      return ax === by ? a.localeCompare(b) : ax > by ? -1 : 1;
    });
    const rows = ours.top_holders ?? [];
    const problems = [];
    const counts = { total_scanned: chain.total, unique_holders: sorted.length };
    if (ours.total_scanned !== counts.total_scanned || ours.unique_holders !== counts.unique_holders)
      problems.push({ counts, ours: { total_scanned: ours.total_scanned, unique_holders: ours.unique_holders } });
    // Ties may be ordered differently; compare each holder at the tool's rank
    // and require its amount to equal the amount at that rank.
    rows.forEach((r, i) => {
      const v = chain.amounts.get(norm(r.address));
      if (!v || String(r.balance) !== String(v.coin + v.address) || String(r.coin_balance) !== String(v.coin) || String(r.address_balance) !== String(v.address) || BigInt(r.balance) !== (sorted[i]?.[1].coin ?? 0n) + (sorted[i]?.[1].address ?? 0n))
        problems.push({ rank: i + 1, holder: r.address, ours: r.balance, chain: v ? String(v.coin + v.address) : null });
    });
    if (rows.length !== Math.min(50, sorted.length)) problems.push({ listed: rows.length, expected: Math.min(50, sorted.length) });
    record("h", key, subject, problems.length ? "disagree" : "agree", { ours: rows.map((r) => [r.address, r.balance]), truth: sorted.map(([id, v]) => [id, String(v.coin + v.address)]), problems });
  }

  // Native bridge event bytes are an independent source of the recipient;
  // restrict this oracle to an EVM transfer with an unambiguous 20-byte field.
  async function bridge(key, digest) {
    const subject = `native bridge ${digest}`;
    const tx = await truthOf("j", key, subject, () => rawTx(digest));
    if (!tx) return;
    const events = tx.events.filter((e) => coinType(e.type) === BRIDGE_DEPOSIT);
    if (!events.length) return skip("j", key, subject, "no outbound native bridge deposit event");
    const expected = [];
    for (const e of events) {
      const chain = Number(e.json?.target_chain);
      const bytes = Buffer.from(e.json?.target_address ?? "", "base64");
      if (chain !== 10 || bytes.length !== 20) return skip("j", key, subject, "recipient uses another destination-chain/address format");
      expected.push({ transfer_id: `${e.json.source_chain}/${e.json.seq_num}`, address: `0x${bytes.toString("hex")}` });
    }
    const ans = answerOf("j", key, subject, await callTool("resolve_bridge_transfer", { digest, include_destination: false }));
    if (!ans) return;
    if (ans.events_incomplete) return skip("j", key, subject, ans.events_incomplete);
    const ours = (ans.sui_native_bridge ?? []).map((r) => ({ transfer_id: r.transfer_id, address: r.destination_address?.toLowerCase() }));
    const problems = expected.filter((e) => !ours.some((r) => r.transfer_id === e.transfer_id && r.address === e.address));
    if (ours.length !== expected.length) problems.push({ reported: ours.length, events: expected.length });
    record("j", key, subject, problems.length ? "disagree" : "agree", { ours, truth: expected, problems });
  }

  // Compare a position's as-of-checkpoint reward with the subsequent
  // withdraw_stake event. An executed payout is independent of the rate reader.
  async function stakeValue(key, digest) {
    const subject = `unstaked SUI ${digest}`;
    const tx = await truthOf("i", key, subject, () => rawTx(digest));
    if (!tx) return;
    const events = tx.events.filter((e) => coinType(e.type) === STAKE_UNSTAKE);
    if (events.length !== 1 || !tx.sender || !Number.isSafeInteger(tx.checkpoint) || tx.checkpoint < 2)
      return skip("i", key, subject, "needs one withdrawal event, a sender and its checkpoint");
    const e = events[0].json;
    const before = await truthOf("i", key, subject, () => gql(`query($c:UInt53!){checkpoint(sequenceNumber:$c){epoch{epochId}}}`, { c: tx.checkpoint - 1 }, true));
    if (!before) return;
    if (Number(before.checkpoint?.epoch?.epochId) !== Number(e.unstaking_epoch))
      return skip("i", key, subject, "withdrawal crossed an epoch boundary; the as-of rate differs");
    const ans = answerOf("i", key, subject, await callTool("get_staking_summary", { address: tx.sender, as_of: String(tx.checkpoint - 1), max_transactions: 200, detail: "full" }));
    if (!ans) return;
    if (!ans.complete || ans.rewards_unavailable) return skip("i", key, subject, `historical holdings or rate read incomplete: ${ans.total_unavailable ?? ans.rewards_unavailable}`);
    const matches = ans.positions.filter((p) => norm(p.pool_id) === norm(e.pool_id) && String(p.principal_mist) === String(e.principal_amount) && String(p.stake_activation_epoch) === String(e.stake_activation_epoch));
    if (matches.length !== 1) return skip("i", key, subject, `${matches.length} as-of positions match the event's pool, principal and activation epoch`);
    const p = matches[0];
    if (p.estimated_reward_mist == null) return skip("i", key, subject, "position reward rate was unavailable");
    // The event caps the payout at the pool's reward balance. The estimated
    // reward excludes that cap, so lower actual payouts are not comparisons.
    if (BigInt(e.reward_amount) < BigInt(p.estimated_reward_mist))
      return skip("i", key, subject, `reward pool may cap the withdrawal (${e.reward_amount} paid, ${p.estimated_reward_mist} estimated)`);
    const observed = { principal: p.principal_mist, reward: p.estimated_reward_mist };
    const expected = { principal: String(e.principal_amount), reward: String(e.reward_amount) };
    const problems = Object.keys(expected).filter((k) => observed[k] !== expected[k]).map((k) => ({ field: k, ours: observed[k], event: expected[k] }));
    record("i", key, subject, problems.length ? "disagree" : "agree", { ours: observed, truth: expected, problems });
  }

  // The index lists only candidate digests. Derive deltas from every
  // transaction's own effects; pin the address balance to a single anchor.
  async function historicalBalance(key, { address, target, anchor }) {
    const a = norm(address), subject = `balance ${a} at ${target} (anchor ${anchor})`;
    const truth = await truthOf("k", key, subject, async () => {
      const start = await gql(`query($a:SuiAddress!,$c:UInt53!){ address(address:$a,atCheckpoint:$c){balance(coinType:"0x2::sui::SUI"){totalBalance}} }`, { a, c: anchor });
      if (!start.address?.balance) throw new Error(`anchor ${anchor} balance unavailable`);
      let after = null, total = 0n, n = 0;
      for (; ;) {
        const d = await gql(`query($a:SuiAddress!,$lo:UInt53!,$hi:UInt53!,$c:String){transactions(filter:{affectedAddress:$a,afterCheckpoint:$lo,beforeCheckpoint:$hi},first:50,after:$c){nodes{digest} pageInfo{hasNextPage endCursor}}}`, { a, lo: target, hi: anchor + 1, c: after }, true);
        for (const row of d.transactions.nodes) {
          const tx = await rawTx(row.digest);
          for (const b of tx.balances) if (b.owner === a && b.coin === SUI) total += b.amount;
          if (++n > 250) return { tooMany: n };
        }
        if (!d.transactions.pageInfo.hasNextPage) break;
        after = d.transactions.pageInfo.endCursor;
        if (!after) throw new Error("balance transaction range has more rows but no cursor");
      }
      return { balance: (BigInt(start.address.balance.totalBalance) - total).toString(), transactions: n };
    });
    if (!truth) return;
    if (truth.tooMany) return skip("k", key, subject, "more than 250 transactions in the anchor interval");
    const ans = answerOf("k", key, subject, await callTool("get_balance", { owner: a, at_checkpoint: target, max_transactions: 1000 }));
    if (!ans) return;
    if (!ans.complete) return skip("k", key, subject, `tool reconstruction incomplete: ${ans.balance_unavailable ?? ans.reached_checkpoint}`);
    const ok = ans.method === "reconstructed" && ans.balance === truth.balance;
    record("k", key, subject, ok ? "agree" : "disagree", { ours: { balance: ans.balance, method: ans.method }, truth, problems: ok ? [] : [{ ours: ans.balance, chain: truth.balance }] });
  }

  // A no-case-check tool: compare a historical checkpoint against GraphQL's
  // checkpoint record rather than its own gRPC read.
  async function checkpoint(key, sequence) {
    const subject = `checkpoint ${sequence}`;
    const d = await truthOf("l", key, subject, () => gql(`query($s:UInt53){checkpoint(sequenceNumber:$s){sequenceNumber timestamp epoch{epochId}}}`, { s: sequence }, true));
    if (!d) return;
    if (!d.checkpoint) return skip("l", key, subject, "GraphQL has no checkpoint record");
    const ans = answerOf("l", key, subject, await callTool("get_checkpoint", { sequence_number: String(sequence) }));
    if (!ans) return;
    const expected = { checkpoint: String(d.checkpoint.sequenceNumber), timestamp: d.checkpoint.timestamp, epoch: String(d.checkpoint.epoch.epochId) };
    const observed = { checkpoint: String(ans.sequence_number ?? ans.sequence ?? ans.checkpoint), timestamp: ans.timestamp, epoch: String(ans.epoch) };
    const problems = Object.keys(expected).filter((k) => observed[k] !== expected[k]).map((k) => ({ field: k, ours: observed[k], chain: expected[k] }));
    record("l", key, subject, problems.length ? "disagree" : "agree", { ours: observed, truth: expected, problems });
  }

  return { funding, holders, stakeValue, bridge, historicalBalance, checkpoint };
}
