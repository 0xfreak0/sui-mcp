/**
 * The pure half of the detector pass: validating the labelled set in
 * cases/detectors.json, reading anomaly flags out of tool results, and
 * scoring them. No I/O, so test/detector-eval.test.ts covers all of it.
 *
 * A flag counts as a detection or a false positive at medium or high. Info
 * flags are tallied but never fail the run.
 */

/**
 * `decode_ptb_bytes` is decode_ptb given the transaction's own BCS, the
 * pre-sign mode, which sees no effects.
 */
export const TOOLS = ["analyze_attack_tx", "decode_ptb", "decode_ptb_bytes"];
export const SEVERITIES = ["high", "medium", "info"];
export const DETECTION_SEVERITIES = new Set(["high", "medium"]);
/**
 * Tuning holds the transactions rule authors looked at; holdout holds the ones
 * they never saw. A holdout positive's incident is one no current rule was
 * designed from or tuned with.
 */
export const SPLITS = ["tuning", "holdout"];

const SET_KEYS = ["about", "detector_origins", "incidents", "positives", "negatives", "accepted_fps", "holdout_ceilings"];
const ORIGIN_KEYS = ["incidents", "tuned_with", "basis"];
const INCIDENT_KEYS = ["title", "cases"];
const POSITIVE_KEYS = ["digest", "incident", "case", "role", "split", "sender", "sender_withheld", "timestamp", "source", "detected_by"];
const NEGATIVE_KEYS = ["digest", "split", "protocol", "shape", "sender", "sender_withheld", "timestamp", "calls", "source"];
const DETECTED_KEYS = ["tool", "code", "evidence"];
const ACCEPTED_KEYS = ["digest", "tool", "code", "reason"];
const CEILING_KEYS = ["measured_on", "negatives", "kinds"];
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADDRESS = /^0x[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** `tool:code`, the unit every table is keyed by. */
export const kindKey = (tool, code) => `${tool}:${code}`;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${where}: unknown key "${k}"`);
}

/**
 * Check the labelled set against the contract in cases/README.md. `caseSlugs`
 * is the set of files in cases/incidents; every incident must name at least
 * one of them. Returns a list of errors, empty when the file is valid.
 */
export function validateLabels(set, { caseSlugs } = {}) {
  const errors = [];
  if (!isObject(set)) return ["the labelled set must be a JSON object"];
  unknownKeys(set, SET_KEYS, "top level", errors);
  for (const k of SET_KEYS.filter((k) => k !== "about")) if (!(k in set)) errors.push(`top level: missing "${k}"`);
  if (!nonEmpty(set.about)) errors.push('top level: "about" must say what the file is');

  const incidents = isObject(set.incidents) ? set.incidents : {};
  if (!isObject(set.incidents)) errors.push('"incidents" must be an object keyed by incident id');
  for (const [id, inc] of Object.entries(incidents)) {
    const where = `incidents.${id}`;
    if (!SLUG.test(id)) errors.push(`${where}: id must be lower-case letters, digits and dashes`);
    if (!isObject(inc)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    unknownKeys(inc, INCIDENT_KEYS, where, errors);
    if (!nonEmpty(inc.title)) errors.push(`${where}: needs a title`);
    if (!Array.isArray(inc.cases) || inc.cases.length === 0) errors.push(`${where}: "cases" must list its case files`);
    else if (caseSlugs) for (const c of inc.cases) if (!caseSlugs.has(c)) errors.push(`${where}: case "${c}" is not in cases/incidents`);
  }

  const origins = isObject(set.detector_origins) ? set.detector_origins : {};
  if (!isObject(set.detector_origins)) errors.push('"detector_origins" must be an object keyed by anomaly code');
  for (const [code, o] of Object.entries(origins)) {
    const where = `detector_origins.${code}`;
    if (!isObject(o)) {
      errors.push(`${where}: must be an object`);
      continue;
    }
    unknownKeys(o, ORIGIN_KEYS, where, errors);
    for (const field of ["incidents", "tuned_with"]) {
      if (!Array.isArray(o[field])) errors.push(`${where}: "${field}" must be an array (empty when none applies)`);
      else for (const i of o[field]) if (!(i in incidents)) errors.push(`${where}.${field}: unknown incident "${i}"`);
    }
    if (!nonEmpty(o.basis)) errors.push(`${where}: needs a basis (the commits or audit items it comes from)`);
  }

  const seen = new Map();
  const note = (digest, where) => {
    if (seen.has(digest)) errors.push(`${where}: ${digest} is already labelled at ${seen.get(digest)}`);
    else seen.set(digest, where);
  };
  const common = (e, where) => {
    if (!DIGEST.test(e.digest ?? "")) errors.push(`${where}: "digest" must be a base58 transaction digest`);
    else note(e.digest, where);
    // An entry a victim signed (a drainer's drain, or a negative drawn from a victim's wallet) names no sender; `sender_withheld` says why.
    if ("sender_withheld" in e) {
      if (!nonEmpty(e.sender_withheld)) errors.push(`${where}: "sender_withheld" must say why the sender is not recorded`);
      if ("sender" in e) errors.push(`${where}: "sender" and "sender_withheld" exclude each other`);
    } else if (!ADDRESS.test(e.sender ?? "")) errors.push(`${where}: "sender" must be a full 0x address`);
    if (!TIMESTAMP.test(e.timestamp ?? "")) errors.push(`${where}: "timestamp" must be the transaction's ISO time in UTC`);
    if (!nonEmpty(e.source)) errors.push(`${where}: needs a source`);
  };

  const positives = Array.isArray(set.positives) ? set.positives : [];
  if (!Array.isArray(set.positives) || positives.length === 0) errors.push('"positives" must be a non-empty array');
  positives.forEach((p, i) => {
    const where = `positives[${i}]`;
    if (!isObject(p)) return errors.push(`${where}: must be an object`);
    unknownKeys(p, POSITIVE_KEYS, where, errors);
    common(p, where);
    if (!(p.incident in incidents)) errors.push(`${where}: unknown incident "${p.incident}"`);
    else if (!incidents[p.incident].cases?.includes(p.case)) errors.push(`${where}: case "${p.case}" is not one of incident ${p.incident}'s cases`);
    if (!nonEmpty(p.role)) errors.push(`${where}: needs a role`);
    if (!SPLITS.includes(p.split)) errors.push(`${where}: "split" must be one of ${SPLITS.join(", ")}`);
    if (!Array.isArray(p.detected_by)) errors.push(`${where}: "detected_by" must be an array (empty when nothing detects it)`);
    else
      p.detected_by.forEach((d, j) => {
        const w = `${where}.detected_by[${j}]`;
        if (!isObject(d)) return errors.push(`${w}: must be an object`);
        unknownKeys(d, DETECTED_KEYS, w, errors);
        if (!TOOLS.includes(d.tool)) errors.push(`${w}: tool must be one of ${TOOLS.join(", ")}`);
        if (!nonEmpty(d.code)) errors.push(`${w}: needs a code`);
        if ("evidence" in d && !nonEmpty(d.evidence)) errors.push(`${w}: "evidence" must be a non-empty string when given`);
      });
  });

  // One incident sits in one split, and a held-out incident is in no rule's origins.
  const incidentSplits = new Map();
  for (const p of positives) {
    if (!isObject(p) || !SPLITS.includes(p.split)) continue;
    incidentSplits.set(p.incident, new Set([...(incidentSplits.get(p.incident) ?? []), p.split]));
  }
  for (const [id, splits] of incidentSplits) {
    if (splits.size > 1) errors.push(`incidents.${id}: its positives are split across ${[...splits].join(" and ")}; one incident sits in one split`);
    else if (splits.has("holdout"))
      for (const [code, o] of Object.entries(origins))
        for (const field of ["incidents", "tuned_with"])
          if (Array.isArray(o?.[field]) && o[field].includes(id))
            errors.push(
              `detector_origins.${code}.${field} lists ${id}, whose positives are split holdout; a rule designed from or tuned with an incident moves its positives to tuning`,
            );
  }

  const negatives = Array.isArray(set.negatives) ? set.negatives : [];
  if (!Array.isArray(set.negatives) || negatives.length === 0) errors.push('"negatives" must be a non-empty array');
  negatives.forEach((n, i) => {
    const where = `negatives[${i}]`;
    if (!isObject(n)) return errors.push(`${where}: must be an object`);
    unknownKeys(n, NEGATIVE_KEYS, where, errors);
    common(n, where);
    if (!SPLITS.includes(n.split)) errors.push(`${where}: "split" must be one of ${SPLITS.join(", ")}`);
    if (!nonEmpty(n.protocol)) errors.push(`${where}: needs a protocol`);
    if (!nonEmpty(n.shape)) errors.push(`${where}: needs a shape`);
    if (!Array.isArray(n.calls) || !n.calls.every(nonEmpty)) errors.push(`${where}: "calls" must list the transaction's Move calls`);
  });

  const splitOf = new Map(negatives.map((n) => [n?.digest, n?.split]));
  const accepted = Array.isArray(set.accepted_fps) ? set.accepted_fps : [];
  if (!Array.isArray(set.accepted_fps)) errors.push('"accepted_fps" must be an array');
  const acceptedSeen = new Set();
  accepted.forEach((a, i) => {
    const where = `accepted_fps[${i}]`;
    if (!isObject(a)) return errors.push(`${where}: must be an object`);
    unknownKeys(a, ACCEPTED_KEYS, where, errors);
    if (!splitOf.has(a.digest)) errors.push(`${where}: ${a.digest} is not a labelled negative`);
    // Holdout is gated by rate against holdout_ceilings, never entry by entry.
    else if (splitOf.get(a.digest) === "holdout") errors.push(`${where}: ${a.digest} is a holdout negative; holdout flags are gated by holdout_ceilings, not accepted one by one`);
    if (!TOOLS.includes(a.tool)) errors.push(`${where}: tool must be one of ${TOOLS.join(", ")}`);
    if (!nonEmpty(a.code)) errors.push(`${where}: needs a code`);
    if (!nonEmpty(a.reason)) errors.push(`${where}: needs a reason`);
    const key = `${a.digest} ${kindKey(a.tool, a.code)}`;
    if (acceptedSeen.has(key)) errors.push(`${where}: duplicate of an earlier entry`);
    acceptedSeen.add(key);
  });

  const ceilings = set.holdout_ceilings;
  const holdoutCount = negatives.filter((n) => n?.split === "holdout").length;
  if (!isObject(ceilings)) errors.push('"holdout_ceilings" must be an object: { measured_on, negatives, kinds }');
  else {
    unknownKeys(ceilings, CEILING_KEYS, "holdout_ceilings", errors);
    if (!nonEmpty(ceilings.measured_on)) errors.push("holdout_ceilings: needs measured_on (the build and date the rates were measured on)");
    if (ceilings.negatives !== holdoutCount)
      errors.push(`holdout_ceilings: measured on ${ceilings.negatives} holdout negatives, but the file has ${holdoutCount}; remeasure after rotating the holdout`);
    if (!isObject(ceilings.kinds)) errors.push('holdout_ceilings: "kinds" must map "tool:code" to a medium-or-high count');
    else
      for (const [key, count] of Object.entries(ceilings.kinds)) {
        const tool = key.slice(0, key.indexOf(":"));
        if (!TOOLS.includes(tool) || !nonEmpty(key.slice(key.indexOf(":") + 1))) errors.push(`holdout_ceilings.kinds: "${key}" is not "tool:code"`);
        if (!Number.isInteger(count) || count < 1 || count > holdoutCount)
          errors.push(`holdout_ceilings.kinds.${key}: must be a count from 1 to ${holdoutCount} (leave a kind that never fires out)`);
      }
  }
  return errors;
}

/**
 * The anomaly flags in one tool result, as
 * `{ tool, code, severity, text, evidence }`. `text` joins the title, detail
 * and evidence so `detected_by.evidence` can require the flag to name the
 * exploited package or function; `evidence` keeps the flag's own list whole.
 */
export function flagsOf(tool, result) {
  const list = Array.isArray(result?.anomalies) ? result.anomalies : [];
  return list.map((a) => ({
    tool,
    code: String(a.code),
    severity: SEVERITIES.includes(a.severity) ? a.severity : "info",
    text: [a.title, a.detail, ...(Array.isArray(a.evidence) ? a.evidence : [])].filter(Boolean).join(" | "),
    evidence: Array.isArray(a.evidence) ? a.evidence.map(String) : [],
  }));
}

const detects = (f) => DETECTION_SEVERITIES.has(f.severity);
const matchesEntry = (entry) => (f) =>
  f.tool === entry.tool && f.code === entry.code && detects(f) && (!entry.evidence || f.text.toLowerCase().includes(entry.evidence.toLowerCase()));
const flagLabels = (flags) => flags.map((f) => `${kindKey(f.tool, f.code)}@${f.severity}`);
const flagDetails = (flags) =>
  flags.filter(detects).map((f) => ({ kind: kindKey(f.tool, f.code), severity: f.severity, text: f.text.slice(0, 400), evidence: f.evidence ?? [] }));

/**
 * Score one run. `results` maps a digest to `{ flags, errors }`, where
 * `errors` lists tool calls that failed. Only labelled transactions present
 * in `results` are scored, so a filtered run judges only what it ran.
 *
 * Fails on: a tuning negative with a medium or high flag that
 * `accepted_fps` does not list; an accepted false positive that no longer
 * fires; a positive that loses a `detected_by` entry; any failed tool call;
 * and, when every holdout negative ran, a kind whose medium-or-high count on
 * holdout differs from its `holdout_ceilings` count. A rise is a regression;
 * a fall means the ceiling must come down to the new count, so the next rise
 * cannot hide under the old one.
 *
 * A detection is held out only when the incident is in neither the
 * detector's `incidents` (designed from) nor its `tuned_with`.
 */
export function scoreRun(set, results) {
  const failures = [];
  // `${incident} ${kind}` -> digests where the kind fired without a detected_by entry.
  const unlisted = new Map();
  const origins = set.detector_origins ?? {};
  const designedFrom = (code) => origins[code]?.incidents ?? null;
  const seenBy = (code) => [...(origins[code]?.incidents ?? []), ...(origins[code]?.tuned_with ?? [])];

  const emptyFp = () => ({ medium_high: 0, any: 0, digests: [] });
  const kinds = new Map();
  const kind = (tool, code) => {
    const key = kindKey(tool, code);
    if (!kinds.has(key))
      kinds.set(key, {
        kind: key,
        tool,
        code,
        true_positives: 0,
        other_positive_hits: 0,
        detected_incidents: new Set(),
        hit_incidents: new Set(),
        fp: Object.fromEntries(SPLITS.map((s) => [s, emptyFp()])),
      });
    return kinds.get(key);
  };
  // Every tool's rules appear in the table even when they fired nowhere.
  for (const code of Object.keys(origins)) for (const tool of TOOLS) kind(tool, code);

  const positives = [];
  for (const p of set.positives ?? []) {
    const r = results.get(p.digest);
    if (!r) continue;
    for (const e of r.errors ?? []) failures.push(`positive ${p.digest} (${p.incident}): ${e}`);
    const matched = (p.detected_by ?? []).filter((entry) => r.flags.some(matchesEntry(entry)));
    if (!(r.errors ?? []).length)
      for (const e of (p.detected_by ?? []).filter((entry) => !matched.includes(entry)))
        failures.push(
          `positive ${p.digest} (${p.incident}) lost its detection by ${kindKey(e.tool, e.code)}${e.evidence ? ` naming ${e.evidence}` : ""}`,
        );
    // Each kind counts once per transaction, however many flags it raised.
    const matchedKinds = new Set(matched.map((e) => kindKey(e.tool, e.code)));
    const firedKinds = new Set();
    for (const f of r.flags) {
      kind(f.tool, f.code);
      if (detects(f)) firedKinds.add(kindKey(f.tool, f.code));
    }
    for (const key of firedKinds) {
      const k = kinds.get(key);
      k.hit_incidents.add(p.incident);
      if (matchedKinds.has(key)) {
        k.true_positives++;
        k.detected_incidents.add(p.incident);
      } else {
        k.other_positive_hits++;
        const noteKey = `${p.incident} ${key}`;
        unlisted.set(noteKey, [...(unlisted.get(noteKey) ?? []), p.digest]);
      }
    }
    positives.push({
      digest: p.digest,
      incident: p.incident,
      role: p.role,
      split: p.split,
      detected: matched.length > 0,
      detected_by: [...matchedKinds],
      flags: flagLabels(r.flags),
      flag_details: flagDetails(r.flags),
      errors: r.errors ?? [],
    });
  }

  const accepted = set.accepted_fps ?? [];
  const negatives = [];
  const negativesRun = Object.fromEntries(SPLITS.map((s) => [s, 0]));
  for (const n of set.negatives ?? []) {
    const r = results.get(n.digest);
    if (!r) continue;
    const split = n.split;
    negativesRun[split]++;
    for (const e of r.errors ?? []) failures.push(`${split} negative ${n.digest} (${n.protocol}): ${e}`);
    const anyKinds = new Map();
    const firedKinds = new Map();
    for (const f of r.flags) {
      const key = kindKey(f.tool, f.code);
      if (!anyKinds.has(key)) anyKinds.set(key, f);
      if (detects(f) && !firedKinds.has(key)) firedKinds.set(key, f);
    }
    for (const f of anyKinds.values()) kind(f.tool, f.code).fp[split].any++;
    for (const [key, f] of firedKinds) {
      const fp = kinds.get(key).fp[split];
      fp.medium_high++;
      fp.digests.push(n.digest);
      if (split === "holdout") continue;
      const ok = accepted.some((a) => a.digest === n.digest && a.tool === f.tool && a.code === f.code);
      if (!ok)
        failures.push(
          `${split} negative ${n.digest} (${n.protocol}, ${n.shape}): ${key} at ${f.severity} is not an accepted known false positive: ${f.text.slice(0, 200)}`,
        );
    }
    if (!(r.errors ?? []).length)
      for (const a of accepted.filter((a) => a.digest === n.digest))
        if (!r.flags.some((f) => f.tool === a.tool && f.code === a.code && detects(f)))
          failures.push(`accepted false positive ${n.digest} ${kindKey(a.tool, a.code)} no longer fires; remove it from accepted_fps`);
    negatives.push({
      digest: n.digest,
      split,
      protocol: n.protocol,
      shape: n.shape,
      flags: flagLabels(r.flags),
      flag_details: flagDetails(r.flags),
      errors: r.errors ?? [],
    });
  }

  const rate = (x, split) => (negativesRun[split] ? Number((x / negativesRun[split]).toFixed(4)) : null);
  const kindRows = [...kinds.values()]
    .map((k) => {
      const detected = [...k.detected_incidents].sort();
      const origin = designedFrom(k.code);
      const seen = seenBy(k.code);
      return {
        kind: k.kind,
        tool: k.tool,
        code: k.code,
        origin_incidents: origin,
        tuned_with: origins[k.code]?.tuned_with ?? null,
        true_positives: k.true_positives,
        other_positive_hits: k.other_positive_hits,
        detects_incidents: detected,
        held_out_detects: detected.filter((i) => !seen.includes(i)),
        fires_on_incidents: [...k.hit_incidents].sort(),
        only_on_origin: origin && origin.length && detected.length ? detected.every((i) => origin.includes(i)) : null,
        fp: Object.fromEntries(
          SPLITS.map((s) => [
            s,
            {
              medium_high: k.fp[s].medium_high,
              rate_medium_high: rate(k.fp[s].medium_high, s),
              any: k.fp[s].any,
              rate_any: rate(k.fp[s].any, s),
              digests: k.fp[s].digests,
            },
          ]),
        ),
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code) || a.tool.localeCompare(b.tool));

  // The holdout gate: a count per kind, judged only on a run of the whole split.
  const holdoutTotal = (set.negatives ?? []).filter((n) => n.split === "holdout").length;
  const ceilingKinds = set.holdout_ceilings?.kinds ?? {};
  const gateRan = holdoutTotal > 0 && negativesRun.holdout === holdoutTotal;
  const gateKeys = [...new Set([...Object.keys(ceilingKinds), ...kindRows.filter((k) => k.fp.holdout.medium_high > 0).map((k) => k.kind)])].sort();
  const holdoutGate = {
    ran: gateRan,
    measured_on: set.holdout_ceilings?.measured_on ?? null,
    negatives: holdoutTotal,
    kinds: gateKeys.map((key) => {
      const measured = kindRows.find((k) => k.kind === key)?.fp.holdout.medium_high ?? 0;
      const ceiling = ceilingKinds[key] ?? 0;
      const status = !gateRan ? "not run" : measured > ceiling ? "rose" : measured < ceiling ? "fell" : "held";
      if (status === "rose")
        failures.push(
          `holdout rate ${key} rose to ${measured} of ${holdoutTotal} (${((100 * measured) / holdoutTotal).toFixed(1)}%) from the ceiling ${ceiling} (${((100 * ceiling) / holdoutTotal).toFixed(1)}%)`,
        );
      if (status === "fell")
        failures.push(`holdout rate ${key} fell to ${measured} of ${holdoutTotal} from the ceiling ${ceiling}; lower holdout_ceilings.kinds to the new count`);
      return {
        kind: key,
        ceiling,
        ceiling_rate: Number((ceiling / holdoutTotal).toFixed(4)),
        measured: gateRan ? measured : null,
        measured_rate: gateRan ? Number((measured / holdoutTotal).toFixed(4)) : null,
        status,
      };
    }),
  };

  const incidentIds = [...new Set(positives.map((p) => p.incident))].sort();
  const incidents = incidentIds.map((id) => {
    const ps = positives.filter((p) => p.incident === id);
    const detectedBy = [...new Set(ps.flatMap((p) => p.detected_by))].sort();
    const heldOut = detectedBy.filter((key) => !seenBy(key.slice(key.indexOf(":") + 1)).includes(id));
    return {
      incident: id,
      title: set.incidents?.[id]?.title,
      split: ps[0].split,
      positives: ps.length,
      positives_detected: ps.filter((p) => p.detected).length,
      detected_by: detectedBy,
      held_out_detected_by: heldOut,
      detected: detectedBy.length > 0,
      detected_by_tool: Object.fromEntries(TOOLS.map((t) => [t, detectedBy.some((k) => k.startsWith(`${t}:`))])),
      other_flags: [...new Set(ps.flatMap((p) => p.flags))].filter((f) => !detectedBy.some((d) => f.startsWith(`${d}@`))).sort(),
    };
  });

  const splitCounts = Object.fromEntries(
    SPLITS.map((s) => {
      const ns = negatives.filter((n) => n.split === s);
      const ps = positives.filter((p) => p.split === s);
      const incs = incidents.filter((inc) => inc.split === s);
      return [
        s,
        {
          positives: ps.length,
          positives_detected: ps.filter((p) => p.detected).length,
          incidents: incs.length,
          incidents_detected: incs.filter((inc) => inc.detected).length,
          negatives: negativesRun[s],
          with_medium_high: ns.filter((n) => n.flags.some((f) => /@(high|medium)$/.test(f))).length,
          with_any_flag: ns.filter((n) => n.flags.length).length,
          failures: failures.filter((f) => f.startsWith(`${s} negative`) || f.startsWith(`${s} rate`)).length,
        },
      ];
    }),
  );

  return {
    counts: { positives: positives.length, incidents: incidents.length, splits: splitCounts },
    kinds: kindRows,
    holdout_gate: holdoutGate,
    incidents,
    positives,
    negatives,
    failures,
    notes: [...unlisted].map(
      ([k, digests]) =>
        `${k.replace(" ", ": ")} fires at medium or high on ${digests.length} positive(s) without a detected_by entry (${digests.join(", ")}); add one if the flag names the attack`,
    ),
  };
}

/**
 * `holdout_ceilings` from a report of the whole holdout split: each kind's
 * medium-or-high count, leaving out kinds that never fired. Null when the
 * report did not cover every holdout negative.
 */
export function ceilingsFrom(report, measuredOn) {
  if (!report.holdout_gate.ran) return null;
  const kinds = Object.fromEntries(
    report.kinds.filter((k) => k.fp.holdout.medium_high > 0).map((k) => [k.kind, k.fp.holdout.medium_high]),
  );
  return { measured_on: measuredOn, negatives: report.holdout_gate.negatives, kinds };
}
