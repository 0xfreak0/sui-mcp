/**
 * Pure parsers for scripts/sync-disclosed-labels.mjs, kept apart so the tests
 * can pin them against real document text.
 */

const HEX_FRAGMENT = /0x[0-9a-fA-F]+/g;
const HEX_ONLY = /^[0-9a-fA-F]+$/;
const FULL_SUI_LENGTH = 66;

/** True when `line` carries `network` as a standalone word (case-insensitive). */
function hasWord(line, network) {
  return new RegExp(`(^|[^A-Za-z])${network}([^A-Za-z]|$)`, "i").test(line);
}

/**
 * Sui addresses listed under `network` in `pdftotext -layout` output.
 *
 * Audit PDFs print the address table in a narrow column, so a 66-character
 * address wraps. Two layouts are handled, both seen in real reports:
 *
 *   Sui      0x555bf909…9c04bd          (Bybit: label and first half on one
 *            30365f6                      line, remainder below)
 *
 *            0x13c07564…abc58           (KuCoin: label on its own line
 *   SUI                                  between the two halves)
 *            58d1511e24c6d
 *
 * An address is accepted only when the pieces join to exactly 0x + 64 hex and
 * the network word sits on one of the lines consumed. A 0x+64-hex address
 * under any other label (Aptos uses the same shape) is ignored.
 */
export function addressesInPdfText(text, network) {
  const lines = text.split(/\r?\n/);
  const out = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(HEX_FRAGMENT)) {
      let address = m[0];
      let labelled = hasWord(line, network);
      const endsLine = line.slice(m.index + m[0].length).trim() === "";
      let j = i;
      while (address.length < FULL_SUI_LENGTH && endsLine && j < i + 3 && j + 1 < lines.length) {
        j++;
        const next = lines[j].trim();
        if (next.toLowerCase() === network.toLowerCase()) {
          labelled = true;
          continue;
        }
        const tokens = next.split(/\s+/);
        const tail = tokens.find((t) => HEX_ONLY.test(t));
        if (!tail) break;
        if (tokens.some((t) => t.toLowerCase() === network.toLowerCase())) labelled = true;
        address += tail;
      }
      if (address.length === FULL_SUI_LENGTH && !labelled && endsLine && i + 1 < lines.length) {
        labelled = lines[i + 1].trim().toLowerCase() === network.toLowerCase();
      }
      if (labelled && /^0x[0-9a-fA-F]{64}$/.test(address)) out.add(address.toLowerCase());
    }
  }
  return [...out];
}

/** Visible text of an HTML page, whitespace collapsed. */
export function htmlToText(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ");
}

/**
 * Whether `text` names `address`, case-insensitively.
 *
 * Short Sui addresses (`0xb`) are matched as a whole token, so `0xb` is not
 * found inside `0xb848cc…`.
 */
export function mentionsAddress(text, address) {
  const a = address.toLowerCase();
  const hay = text.toLowerCase();
  if (a.length >= 42) return hay.includes(a);
  return new RegExp(`(^|[^0-9a-fx])${a}(?![0-9a-f])`).test(hay);
}

/**
 * Every title string in a Notion `loadCachedPageChunkV2` / `loadPageChunk`
 * response, one per line. Blocks nest their value one level deeper in newer
 * responses (`value.value`), so both shapes are read.
 */
export function extractNotionText(json) {
  const blocks = json?.recordMap?.block ?? {};
  const lines = [];
  for (const b of Object.values(blocks)) {
    const v = b?.value?.value ?? b?.value;
    const title = v?.properties?.title;
    if (!Array.isArray(title)) continue;
    lines.push(title.map((seg) => (Array.isArray(seg) ? String(seg[0] ?? "") : "")).join(""));
  }
  return lines.join("\n");
}
