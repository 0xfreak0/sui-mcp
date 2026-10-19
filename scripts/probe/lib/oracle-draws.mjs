/* A zero source bound disables its oracle; an enabled oracle with no checks still fails. */
export function oracleRequested(id, { pinned, txs, ends, router, coins }) {
  if (pinned) return !!pinned[id]?.length;
  switch (id) {
    case "a": return router > 0;
    case "b": return ends + coins > 0;
    case "c":
    case "e": return txs + router > 0;
    case "d":
    case "f":
    case "h": return coins > 0;
    case "g": return txs > 0;
    case "i":
    case "j":
    case "k":
    case "l": return true;
    default: throw new Error(`unknown oracle ${id}`);
  }
}

export function oracleDrawState(id, options, checked) {
  if (!oracleRequested(id, options)) return "not_drawn";
  if (checked > 0) return "checked";
  return id === "i" && options.stakeBoundReached ? "drawn_but_unverifiable" : "unchecked";
}

const stakeType = (type) => String(type).replace(/(^|[<,\s])(?:0x)?([0-9a-fA-F]{1,64})(?=::)/g, (_, pre, hex) => `${pre}0x${hex.toLowerCase().padStart(64, "0")}`);
const STAKED_SUI = stakeType("0x3::staking_pool::StakedSui");
const UNSTAKING_EVENT = stakeType("0x3::validator::UnstakingRequestEvent");

// The reward oracle needs an event and a position it could have held at C-1.
// Fungible stake withdrawals can call the same function without that position.
export function checkableStakeWithdrawal(tx) {
  if (!tx?.sender || !Number.isSafeInteger(tx.checkpoint) || tx.checkpoint < 2 ||
    !tx.events?.some((event) => stakeType(event.type) === UNSTAKING_EVENT)) return false;
  for (const change of tx.changes?.values() ?? [])
    if (change.deleted && change.input && stakeType(change.input.type) === STAKED_SUI) return true;
  return false;
}
