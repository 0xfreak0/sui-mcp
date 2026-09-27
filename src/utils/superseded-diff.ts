/**
 * Whether the newest version of a lineage changed a function a superseded
 * version ran, read by diffing the two versions' disassembly of its module
 * (package-diff.ts, which ignores numbering a recompile shifts).
 *
 * Each module pair costs two GraphQL reads, so the read is bounded per call;
 * a pair past the bound or whose read failed is `unread`, which
 * stale-package-version reports as not compared.
 */

import { fetchModuleDisassembly } from "./move-package.js";
import { diffPackages } from "./package-diff.js";
import type { FunctionChangeSince } from "./ptb-anomalies.js";

/** Module pairs compared per tool call. */
export const MAX_SUPERSEDED_MODULES = 8;

/**
 * For each `{ target, newest }` (`package::module::function` of a superseded
 * version, and the newest version's package id), how the newest version
 * treats that function. Keyed by `target`.
 */
export async function readSupersededChanges(writes: Array<{ target: string; newest: string }>): Promise<Map<string, FunctionChangeSince>> {
  const out = new Map<string, FunctionChangeSince>();
  const byModule = new Map<string, { pkg: string; module: string; newest: string; targets: string[] }>();
  for (const w of writes) {
    const [pkg, module, fn] = w.target.split("::");
    if (!pkg || !module || !fn) continue;
    const key = `${pkg}::${module}::${w.newest}`;
    const entry = byModule.get(key) ?? { pkg, module, newest: w.newest, targets: [] };
    entry.targets.push(w.target);
    byModule.set(key, entry);
  }
  for (const [i, m] of [...byModule.values()].entries()) {
    if (i >= MAX_SUPERSEDED_MODULES) {
      for (const t of m.targets) out.set(t, "unread");
      continue;
    }
    let diff;
    try {
      const [called, newest] = await Promise.all([fetchModuleDisassembly(m.pkg, m.module), fetchModuleDisassembly(m.newest, m.module)]);
      diff = diffPackages(new Map([[m.module, called]]), new Map([[m.module, newest]]));
    } catch {
      // A module the newest version dropped reads as a failed fetch too; it
      // is reported as not compared rather than guessed.
      for (const t of m.targets) out.set(t, "unread");
      continue;
    }
    for (const t of m.targets) {
      const fn = t.split("::")[2];
      out.set(
        t,
        diff.changed_functions.some((f) => f.function === fn) ? "changed" : diff.removed_functions.some((f) => f.function === fn) ? "removed" : "same",
      );
    }
  }
  return out;
}
