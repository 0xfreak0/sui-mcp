/* Raw-chain comparisons for oracle-pass. No production helper is imported here. */
import { bcs } from "@mysten/sui/bcs";

const SUI = `0x${"2".padStart(64, "0")}::sui::SUI`;
const norm = (a) => `0x${String(a).replace(/^0x/i, "").toLowerCase().padStart(64, "0")}`;
const coinType = (t) => String(t).replace(/(^|[<,\s])(?:0x)?([0-9a-fA-F]{1,64})(?=::)/g, (_, p, h) => `${p}0x${h.toLowerCase().padStart(64, "0")}`).replace(/,\s*/g, ", ");
const STAKE_UNSTAKE = coinType("0x3::validator::UnstakingRequestEvent");
const STAKED_SUI = coinType("0x3::staking_pool::StakedSui");
const BRIDGE_DEPOSIT = coinType("0xb::bridge::TokenDepositedEvent");
const balanceField = (t) => `0x2::dynamic_field::Field<0x2::accumulator::Key<0x2::balance::Balance<${t}>>,0x2::accumulator::U128>`;

/** `0xb::bridge::TokenDepositedEvent`, field for field, to decode the event's own BCS. */
const TokenDeposited = bcs.struct("TokenDepositedEvent", {
  seq_num: bcs.u64(),
  source_chain: bcs.u8(),
  sender_address: bcs.vector(bcs.u8()),
  target_chain: bcs.u8(),
  target_address: bcs.vector(bcs.u8()),
  token_type: bcs.u8(),
  amount: bcs.u64(),
});

/**
 * Funding's unpriced-coin rule, with a margin either side: below
 * `UNPRICED_TARGETED_SHARE` (0.01% of supply) no reading makes an unpriced
 * inflow funding; at `UNPRICED_SUPPLY_SHARE` (1%) or more it counts whatever
 * the sender or send shape. Between them the publisher and send-shape reads
 * decide, which this oracle does not reproduce.
 */
const SPAM_BELOW = 0.00009;
const COUNTS_FROM = 0.011;

/** The object in `json` whose `id` is `id` and that has `field`, searched depth first. */
function findById(json, id, field) {
  if (Array.isArray(json)) {
    for (const x of json) {
      const hit = findById(x, id, field);
      if (hit) return hit;
    }
  } else if (json && typeof json === "object") {
    if (typeof json.id === "string" && norm(json.id) === id && field in json) return json;
    for (const v of Object.values(json)) {
      const hit = findById(v, id, field);
      if (hit) return hit;
    }
  }
  return null;
}

export function extraOracles({ gql, grpc, archive, rawTx, callTool, answerOf, truthOf, record, skip }) {
  /** A transaction's events over gRPC, fullnode then archive; GraphQL is not on this path. */
  async function grpcEvents(digest) {
    for (const client of archive && archive !== grpc ? [grpc, archive] : [grpc]) {
      try {
        const { response } = await client.ledgerService.getTransaction({ digest, readMask: { paths: ["events"] } });
        return response.transaction?.events?.events ?? [];
      } catch (err) {
        if (client === archive || !/NOT_FOUND|not found/i.test(String(err))) throw err;
      }
    }
    return [];
  }

  // The earliest affected-address index locates the first transactions.
  // Read each transaction's full balance changes independently of funding.
  // Price, decimals and supply are read directly from their sources, never
  // through the funding tool's helper. An unpriced inflow is decided only
  // where its share of supply settles it whatever the publisher and send
  // shape say; anything between is a skip.
  async function funding(key, address) {
    const a = norm(address);
    const subject = `funding ${a}`;
    const data = await truthOf("g", key, subject, async () => {
      const d = await gql(`query($a:SuiAddress!){ transactions(filter:{affectedAddress:$a},first:12){ nodes{digest} pageInfo{hasNextPage} } }`, { a });
      const transactions = [];
      for (const n of d.transactions.nodes) transactions.push(await rawTx(n.digest));
      const types = [...new Set(transactions.flatMap((tx) => tx.balances.filter((c) => c.owner === a && c.amount > 0n && c.coin !== SUI).map((c) => c.coin)))];
      if (!types.length) return { transactions, prices: new Map(), decimals: new Map(), supply: new Map() };
      if (types.length > 25) return { tooManyTypes: types.length };
      const response = await fetch("https://aftermath.finance/api/price-info", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coins: [SUI, ...types] }), signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`funding price read returned ${response.status}`);
      const quotes = await response.json();
      const prices = new Map(Object.entries(quotes).filter(([, value]) => typeof value?.price === "number" && value.price >= 0).map(([type, value]) => [coinType(type), value.price]));
      const decimals = new Map();
      const supply = new Map();
      for (const type of types) {
        if (prices.has(type)) {
          const { response: coin } = await grpc.stateService.getCoinInfo({ coinType: type });
          decimals.set(type, coin.metadata?.decimals ?? null);
        } else {
          const m = await gql(`query($t:String!){ coinMetadata(coinType:$t){ supply } }`, { t: type });
          const s = m.coinMetadata?.supply;
          supply.set(type, typeof s === "string" && /^\d+$/.test(s) && BigInt(s) > 0n ? BigInt(s) : null);
        }
      }
      return { transactions, prices, decimals, supply };
    });
    if (!data) return;
    if (data.tooManyTypes) return skip("g", key, subject, `first transactions carry ${data.tooManyTypes} coin types, past the price bound`);
    if (data.transactions.some((tx) => tx.balances.some((c) => c.owner === a && c.amount > 0n && c.coin !== SUI)) && !data.prices.has(SUI))
      return skip("g", key, subject, "price service did not quote SUI, so non-SUI funding is unresolved");
    let expected = null;
    let funderUnchecked = null;
    for (const tx of data.transactions) {
      const incomes = tx.balances.filter((c) => c.owner === a && c.amount > 0n);
      const ranked = [];
      const unpriced = [];
      for (const income of incomes) {
        if (income.coin === SUI) {
          if (income.amount < 10_000_000n) continue;
          ranked.push({ income, usd: data.prices.has(SUI) ? Number(income.amount) * data.prices.get(SUI) / 1e9 : null });
          continue;
        }
        if (!data.prices.has(income.coin)) {
          unpriced.push(income);
          continue;
        }
        const scale = data.decimals.get(income.coin);
        if (!Number.isInteger(scale)) return skip("g", key, subject, `decimals unavailable for ${income.coin}`);
        const usd = Number(income.amount) * data.prices.get(income.coin) / 10 ** scale;
        if (!Number.isFinite(usd) || (usd >= 0.09 && usd <= 0.11)) return skip("g", key, subject, `ambiguous value near the $0.10 floor for ${income.coin}`);
        if (usd >= 0.10) ranked.push({ income, usd });
      }
      // Priced inflows rank above unpriced ones, so a qualifying priced
      // inflow decides the transaction whatever the unpriced ones are.
      if (!ranked.length) {
        const counting = [];
        for (const income of unpriced) {
          const total = data.supply.get(income.coin);
          if (!total) return skip("g", key, subject, `supply of unpriced ${income.coin} unavailable`);
          const share = Number((income.amount * 1_000_000n) / total) / 1_000_000;
          if (share >= COUNTS_FROM) counting.push(income);
          else if (share >= SPAM_BELOW) return skip("g", key, subject, `unpriced ${income.coin} is ${share} of supply, which the publisher and send shape decide`);
        }
        if (!counting.length) continue;
        counting.sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));
        if (counting.length > 1 && counting[0].amount === counting[1].amount) return skip("g", key, subject, "unpriced inflows of equal raw amount");
        ranked.push({ income: counting[0], usd: null });
      }
      if (ranked.length > 1 && ranked.some((r) => r.usd === null))
        return skip("g", key, subject, "SUI quote unavailable to rank multiple inflows in one transaction");
      ranked.sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0));
      if (ranked.length > 1 && ranked[1].usd >= ranked[0].usd * 0.95)
        return skip("g", key, subject, "competing inflows are too close in value for separate live price reads");
      const selected = ranked[0].income;
      const sent = tx.balances.filter((c) => c.coin === selected.coin && c.owner !== a && c.amount < 0n).sort((x, y) => x.amount < y.amount ? -1 : x.amount > y.amount ? 1 : 0);
      if (sent.length > 1 && sent[0].amount === sent[1].amount) return skip("g", key, subject, "equal debits do not identify a unique funder");
      // No address paid this coin (an object did): the funding transaction is
      // still decided, the funder is not one the balance changes name.
      if (!sent.length) funderUnchecked = `no address paid ${selected.coin} in ${tx.digest}`;
      expected = { funding_tx: tx.digest, funded_by: sent[0]?.owner ?? null };
      break;
    }
    const ours = answerOf("g", key, subject, await callTool("find_funding_source", { address: a, max_hops: 1, measure_fanout: false }));
    if (!ours) return;
    if (ours.incomplete_balance_changes?.length || ours.prices_unavailable_at?.length || ours.origin_unread_at?.length)
      return skip("g", key, subject, "funding judgement reports incomplete chain reads or prices");
    const hop = ours.chain?.[0];
    const observed = hop ? { funding_tx: hop.funding_tx, funded_by: /^0x[0-9a-f]+$/i.test(hop.funded_by ?? "") ? norm(hop.funded_by) : hop.funded_by ?? null } : null;
    // Every inflow was settled as below a floor or as spam, so the tool must
    // report no first funding in this window.
    const ok = expected === null
      ? observed === null
      : observed?.funding_tx === expected.funding_tx && (funderUnchecked !== null || observed.funded_by === expected.funded_by);
    record("g", key, subject, ok ? "agree" : "disagree", {
      ours: observed, truth: expected, ...(funderUnchecked ? { funder_unchecked: funderUnchecked } : {}),
      problems: ok ? [] : [{ observed, expected }],
    });
  }

  // Enumerate both object types to completion. These are the same two
  // filtered walks the tool makes; what is independent is the summing,
  // ranking and counting, and each listed holder's total, which is checked
  // against a gRPC balance read.
  async function holderWalk(type, max = 250) {
    const amounts = new Map();
    let unresolved = 0;
    const tally = (address, coin, addressBalance) => {
      if (!/^\d+$/.test(String(coin))) throw new Error("holder entry has no amount");
      if (!address) return void unresolved++;
      const id = norm(address);
      const r = amounts.get(id) ?? { coin: 0n, address: 0n };
      r[addressBalance ? "address" : "coin"] += BigInt(coin);
      amounts.set(id, r);
    };
    let total = 0;
    for (const [filter, isBalance] of [[`0x2::coin::Coin<${type}>`, false], [balanceField(type), true]]) {
      let after = null;
      for (; ;) {
        const d = await gql(`query($t:String!,$a:String){ objects(filter:{type:$t},first:50,after:$a){ nodes{ owner{ __typename ... on AddressOwner{address{address}} ... on ConsensusAddressOwner{address{address}}} asMoveObject{contents{json}} } pageInfo{hasNextPage endCursor} } }`, { t: filter, a: after });
        for (const o of d.objects.nodes) {
          const j = o.asMoveObject?.contents?.json;
          if (isBalance) {
            if (!j?.name?.address) throw new Error("address-balance entry names no owner");
            tally(j.name.address, j?.value?.value, true);
          } else tally(o.owner?.address?.address, j?.balance, false);
          if (++total > max) return { tooMany: total };
        }
        if (!d.objects.pageInfo.hasNextPage) break;
        after = d.objects.pageInfo.endCursor;
        if (!after) throw new Error("holder connection has more rows but no cursor");
      }
    }
    return { amounts, total, unresolved };
  }
  async function holders(key, type) {
    const t = coinType(type), subject = `holders ${t}`;
    const chain = await truthOf("h", key, subject, () => holderWalk(t));
    if (!chain) return;
    if (chain.tooMany) return skip("h", key, subject, `${chain.tooMany} objects already exceed the 250-object independent walk bound`);
    if (!chain.total) return skip("h", key, subject, "coin has no held Coin<T> objects or address balances");
    const ours = answerOf("h", key, subject, await callTool("get_top_holders", { type: t, mode: "token", max_scan: 300, limit: 50 }));
    if (!ours) return;
    if (!ours.complete_ranking || ours.omitted?.lists?.top_holders)
      return skip("h", key, subject, "tool says the walk is incomplete");
    const sorted = [...chain.amounts].sort(([a, x], [b, y]) => {
      const ax = x.coin + x.address, by = y.coin + y.address;
      return ax === by ? a.localeCompare(b) : ax > by ? -1 : 1;
    });
    const rows = ours.top_holders ?? [];
    const problems = [];
    const counts = { total_scanned: chain.total, unique_holders: sorted.length, unresolved_owners: chain.unresolved };
    const theirs = { total_scanned: ours.total_scanned, unique_holders: ours.unique_holders, unresolved_owners: ours.unresolved_owners ?? 0 };
    if (Object.keys(counts).some((k) => theirs[k] !== counts[k])) problems.push({ counts, ours: theirs });
    // Ties may be ordered differently; compare each holder at the tool's rank
    // and require its amount to equal the amount at that rank.
    rows.forEach((r, i) => {
      const v = chain.amounts.get(norm(r.address));
      if (!v || String(r.balance) !== String(v.coin + v.address) || String(r.coin_balance) !== String(v.coin) || String(r.address_balance) !== String(v.address) || BigInt(r.balance) !== (sorted[i]?.[1].coin ?? 0n) + (sorted[i]?.[1].address ?? 0n))
        problems.push({ rank: i + 1, holder: r.address, ours: r.balance, chain: v ? String(v.coin + v.address) : null });
    });
    if (rows.length !== Math.min(50, sorted.length)) problems.push({ listed: rows.length, expected: Math.min(50, sorted.length) });
    // The walk is the tool's own query. A gRPC balance read for each listed
    // holder is the independent side; one that moved after the walk is a skip.
    const moved = [];
    try {
      for (const r of rows.slice(0, 20)) {
        const v = chain.amounts.get(norm(r.address));
        if (!v) continue;
        const { balance } = await grpc.getBalance({ owner: norm(r.address), coinType: t });
        if (BigInt(balance.balance) !== v.coin + v.address) moved.push({ holder: r.address, walk: String(v.coin + v.address), grpc: String(balance.balance) });
      }
    } catch (err) {
      return skip("h", key, subject, `gRPC balance read failed: ${String(err?.message ?? err).slice(0, 200)}`);
    }
    if (moved.length && !problems.length) return skip("h", key, subject, `holder totals differ from a gRPC balance read (moved during the run, or the index lags): ${JSON.stringify(moved).slice(0, 300)}`);
    record("h", key, subject, problems.length ? "disagree" : "agree", { ours: rows.map((r) => [r.address, r.balance]), truth: sorted.map(([id, v]) => [id, String(v.coin + v.address)]), problems, ...(moved.length ? { grpc_differs: moved } : {}) });
  }

  // The deposit event's own BCS, read over gRPC (fullnode, then archive) and
  // decoded field by field here. The tool reads GraphQL's JSON rendering.
  async function bridge(key, digest) {
    const subject = `native bridge ${digest}`;
    const events = await truthOf("j", key, subject, async () => {
      const out = [];
      for (const e of await grpcEvents(digest)) {
        if (coinType(e.eventType ?? "") !== BRIDGE_DEPOSIT) continue;
        const bytes = e.contents?.value;
        if (!bytes) throw new Error("deposit event carries no BCS contents");
        const v = TokenDeposited.parse(bytes);
        if (TokenDeposited.serialize(v).toBytes().length !== bytes.length) throw new Error("deposit event BCS has trailing bytes");
        out.push(v);
      }
      return { events: out };
    });
    if (!events) return;
    if (!events.events.length) return skip("j", key, subject, "no outbound native bridge deposit event");
    const expected = [];
    for (const e of events.events) {
      if (e.target_chain !== 10 || e.target_address.length !== 20 || e.sender_address.length !== 32)
        return skip("j", key, subject, "recipient uses another destination-chain/address format");
      expected.push({
        transfer_id: `${e.source_chain}/${e.seq_num}`,
        address: `0x${Buffer.from(e.target_address).toString("hex")}`,
        sender: norm(Buffer.from(e.sender_address).toString("hex")),
        amount: String(e.amount),
      });
    }
    const ans = answerOf("j", key, subject, await callTool("resolve_bridge_transfer", { digest, include_destination: false }));
    if (!ans) return;
    if (ans.events_incomplete) return skip("j", key, subject, ans.events_incomplete);
    const ours = (ans.sui_native_bridge ?? []).map((r) => ({
      transfer_id: r.transfer_id, address: r.destination_address?.toLowerCase(),
      sender: r.sender ? norm(r.sender) : null, amount: r.amount == null ? null : String(r.amount),
    }));
    const same = (x, y) => x.transfer_id === y.transfer_id && x.address === y.address && x.sender === y.sender && x.amount === y.amount;
    const problems = expected.filter((e) => !ours.some((r) => same(r, e))).map((e) => ({ missing: e }));
    if (ours.length !== expected.length) problems.push({ reported: ours.length, events: expected.length });
    record("j", key, subject, problems.length ? "disagree" : "agree", { ours, truth: expected, problems });
  }

  // Compare each withdrawn position's as-of-checkpoint reward with its
  // UnstakingRequestEvent. The executed payout is independent of the rate
  // reader; the position is the StakedSui object the withdrawal deleted.
  async function stakeValue(key, digest) {
    const subject = `unstaked SUI ${digest}`;
    const tx = await truthOf("i", key, subject, () => rawTx(digest));
    if (!tx) return;
    const events = tx.events.filter((e) => coinType(e.type) === STAKE_UNSTAKE).map((e) => e.json);
    if (!events.length || !tx.sender || !Number.isSafeInteger(tx.checkpoint) || tx.checkpoint < 2)
      return skip("i", key, subject, "needs a withdrawal event, a sender and its checkpoint");
    const before = await truthOf("i", key, subject, () => gql(`query($c:UInt53!){checkpoint(sequenceNumber:$c){epoch{epochId}}}`, { c: tx.checkpoint - 1 }, true));
    if (!before) return;
    if (events.some((e) => Number(before.checkpoint?.epoch?.epochId) !== Number(e.unstaking_epoch)))
      return skip("i", key, subject, "withdrawal crossed an epoch boundary; the as-of rate differs");
    const withdrawn = new Set([...tx.changes.values()].filter((c) => c.deleted && c.input && coinType(c.input.type) === STAKED_SUI).map((c) => norm(c.id)));
    if (!withdrawn.size) return skip("i", key, subject, "the withdrawal deleted no StakedSui that existed before it");
    const ans = answerOf("i", key, subject, await callTool("get_staking_summary", { address: tx.sender, as_of: String(tx.checkpoint - 1), max_transactions: 200, detail: "full" }));
    if (!ans) return;
    if (!ans.complete || ans.rewards_unavailable) return skip("i", key, subject, `historical holdings or rate read incomplete: ${ans.total_unavailable ?? ans.rewards_unavailable}`);
    const held = (ans.positions ?? []).filter((p) => withdrawn.has(norm(p.object_id)));
    const observed = [], expected = [], problems = [];
    let pool = null;
    for (const e of events) {
      // Positions with the same pool, principal and activation epoch hold the
      // same pool tokens, so any of them carries the reward this one earned.
      const matches = held.filter((p) => norm(p.pool_id) === norm(e.pool_id) && String(p.principal_mist) === String(e.principal_amount) && String(p.stake_activation_epoch) === String(e.stake_activation_epoch));
      if (!matches.length) continue;
      const ours = { pool_id: norm(e.pool_id), principal: String(matches[0].principal_mist), rewards: [...new Set(matches.map((p) => String(p.estimated_reward_mist)))] };
      const truth = { pool_id: norm(e.pool_id), principal: String(e.principal_amount), reward: String(e.reward_amount) };
      observed.push(ours);
      expected.push(truth);
      if (ours.rewards.length === 1 && ours.rewards[0] === truth.reward) continue;
      // withdraw_rewards pays min(computed reward, rewards_pool). A shortfall
      // is the cap only when the event paid out the whole pool.
      if (ours.rewards.length === 1 && /^\d+$/.test(ours.rewards[0]) && BigInt(truth.reward) < BigInt(ours.rewards[0])) {
        pool ??= await truthOf("i", key, subject, () => rewardsPools(tx));
        if (!pool) return;
        const balance = pool.get(truth.pool_id);
        if (balance === undefined) return skip("i", key, subject, `rewards pool of ${truth.pool_id} unreadable before the withdrawal`);
        if (balance === BigInt(truth.reward)) return skip("i", key, subject, `the rewards pool cap bound (${truth.reward} paid, ${ours.rewards[0]} estimated)`);
      }
      problems.push({ field: "reward", ours: ours.rewards.join("|"), event: truth.reward, pool_id: truth.pool_id });
    }
    if (!expected.length) return skip("i", key, subject, "no as-of position is a deleted StakedSui matching a withdrawal event");
    record("i", key, subject, problems.length ? "disagree" : "agree", { ours: observed, truth: expected, problems });
  }

  /** Each staking pool's rewards_pool balance in the system state the transaction read. */
  async function rewardsPools(tx) {
    const pools = new Map();
    const events = tx.events.filter((e) => coinType(e.type) === STAKE_UNSTAKE).map((e) => norm(e.json.pool_id));
    for (const c of tx.changes.values()) {
      if (!c.input || c.input.type === STAKED_SUI || !/sui_system_state_inner|validator/.test(c.input.type ?? "")) continue;
      const d = await gql(`query($a:SuiAddress!,$v:UInt53!){ object(address:$a,version:$v){ asMoveObject{ contents{ json } } } }`, { a: c.id, v: Number(c.input.version) }, true);
      const json = d.object?.asMoveObject?.contents?.json;
      for (const id of events) {
        const p = findById(json, id, "rewards_pool");
        const v = typeof p?.rewards_pool === "string" ? p.rewards_pool : p?.rewards_pool?.value;
        if (v !== undefined && /^\d+$/.test(String(v))) pools.set(id, BigInt(v));
      }
    }
    return pools;
  }

  // The index lists only candidate digests. Derive deltas from every
  // transaction's own effects; pin the address balance to a single anchor
  // that differs from the one the tool picks.
  async function historicalBalance(key, { address, target, anchor }) {
    const a = norm(address), subject = `balance ${a} at ${target} (anchor ${anchor})`;
    const truth = await truthOf("k", key, subject, async () => {
      const start = await gql(`query($a:SuiAddress!,$c:UInt53!){ address(address:$a,atCheckpoint:$c){balance(coinType:"0x2::sui::SUI"){totalBalance}} }`, { a, c: anchor });
      if (!start.address?.balance) throw new Error(`anchor ${anchor} balance unavailable (outside the consistent range now?)`);
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
    // A drawn target is below the consistent range, so the tool reconstructs;
    // a pinned one may have been read directly, which must agree as well.
    const ok = ans.balance === truth.balance;
    record("k", key, subject, ok ? "agree" : "disagree", { ours: { balance: ans.balance, method: ans.method }, truth, problems: ok ? [] : [{ ours: ans.balance, method: ans.method, chain: truth.balance }] });
  }

  // GraphQL's checkpoint records against get_checkpoint's gRPC read, by
  // number and by time: the time of checkpoint s, when s-1 is earlier, has
  // s as its first checkpoint at or after it and s-1 as the last before.
  async function checkpoint(key, sequence) {
    const subject = `checkpoint ${sequence}`;
    const sel = "sequenceNumber digest previousCheckpointDigest timestamp networkTotalTransactions epoch{epochId}";
    const d = await truthOf("l", key, subject, () => gql(`query($s:UInt53!,$p:UInt53!){ c:checkpoint(sequenceNumber:$s){${sel}} p:checkpoint(sequenceNumber:$p){timestamp} }`, { s: sequence, p: Math.max(0, sequence - 1) }, true));
    if (!d) return;
    if (!d.c) return skip("l", key, subject, "GraphQL has no checkpoint record");
    const c = d.c;
    const byNumber = answerOf("l", key, subject, await callTool("get_checkpoint", { sequence_number: String(sequence) }));
    if (!byNumber) return;
    const expected = {
      checkpoint: String(c.sequenceNumber), digest: c.digest, previous_digest: c.previousCheckpointDigest ?? null,
      timestamp: Date.parse(c.timestamp), epoch: String(c.epoch.epochId), total_network_transactions: String(c.networkTotalTransactions),
    };
    const observed = {
      checkpoint: String(byNumber.sequence_number), digest: byNumber.digest, previous_digest: byNumber.previous_digest ?? null,
      timestamp: Date.parse(byNumber.timestamp), epoch: String(byNumber.epoch), total_network_transactions: String(byNumber.total_network_transactions),
    };
    const problems = Object.keys(expected).filter((k) => observed[k] !== expected[k]).map((k) => ({ field: k, ours: observed[k], chain: expected[k] }));
    const ms = Date.parse(c.timestamp);
    if (sequence > 0 && Date.parse(d.p?.timestamp) < ms) {
      const byTime = answerOf("l", key, subject, await callTool("get_checkpoint", { timestamp: new Date(ms).toISOString() }));
      if (!byTime) return;
      const t = byTime.resolved_from_timestamp;
      const got = { nearest: byTime.sequence_number, last_before: t?.last_before?.sequence_number ?? null, first_at_or_after: t?.first_at_or_after?.sequence_number ?? null };
      const want = { nearest: String(sequence), last_before: String(sequence - 1), first_at_or_after: String(sequence) };
      for (const k of Object.keys(want)) if (String(got[k]) !== want[k]) problems.push({ field: `by_time.${k}`, ours: got[k], chain: want[k] });
      observed.by_time = got;
      expected.by_time = want;
    }
    record("l", key, subject, problems.length ? "disagree" : "agree", { ours: observed, truth: expected, problems });
  }

  return { funding, holders, stakeValue, bridge, historicalBalance, checkpoint };
}
