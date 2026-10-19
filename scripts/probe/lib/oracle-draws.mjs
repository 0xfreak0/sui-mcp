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
  return checked > 0 ? "checked" : "unchecked";
}
