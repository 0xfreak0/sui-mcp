# Blind investigation brief

Hand this file to a person or an agent to run one blind investigation. The
investigator works a real, public Sui incident with the MCP tools alone, grades
every answer against the published post-mortem and the chain, and delivers a
case file that `scripts/probe/case-pass.mjs` replays on every
`npm run verify:live`.

"Blind" means blind to the implementation. The investigator sees what a user
sees and nothing more, so a wrong answer cannot be explained away by knowing
how the code works.

## Assignment

The person handing this out fills in:

- **Kind**: one of `protocol-exploit`, `address-poisoning`, `wallet-drainer`,
  `token-rug`, `sybil-farm`, `key-compromise`, `nft-theft`, `laundering`,
  `other`. Optionally a named incident.
- **Tools to try**: the tools a user would reach for on this kind of case,
  plus any the last rounds did not exercise.
- **Output directory**: where the deliverables go, outside the repo.

## Rules

1. Use only the MCP tools, as a user would. Do not read the code in `src/`,
   `test/` or `scripts/`; running the snippet below is fine. `README.md`, the
   docs pages under `site/src/content/docs/`,
   `.claude/skills/sui-forensics/SKILL.md`, `cases/README.md`, this brief and
   the server's `tools/list` are allowed.
2. Raw GraphQL and block explorers are allowed only to verify an answer after
   a tool gave one. Never use them to find the answer first.
3. Work like an investigator, following the method in `SKILL.md`. Try the
   tools you would not normally reach for.
4. Grade every answer against the ground truth, and keep the exact call, an
   excerpt of the output and the ground truth for each one.
5. Do not edit the repo. Write only to the output directory.
6. Keep calls sequential. The public GraphQL endpoint is shared and rate
   limited.

## Calling a tool

Connect the built server to any MCP client with `SUI_TOOLS=all`, or call one
tool from a checkout (after `npm run build`):

```bash
node --input-type=module -e '
import { startServer } from "./scripts/probe/lib/mcp-client.mjs";
const [tool, args = "{}"] = process.argv.slice(1);
const s = await startServer({ name: "blind", env: process.env.SUI_STORE_PATH ? { SUI_STORE_PATH: process.env.SUI_STORE_PATH } : {} });
const r = await s.callRaw(tool, JSON.parse(args));
console.log(r.error ? r.error.message : r.result.content.map((c) => c.text).join("\n"));
s.stop();
' find_funding_source '{"address":"0x…"}'
```

Set `SUI_STORE_PATH` to a file in the output directory so labels, findings and
cached reads persist between calls.

## Steps

1. **Pick the incident.** It must have a published post-mortem or analysis
   that names Sui addresses, transaction digests or coin types: the victim's
   own report, a security firm's write-up, an official or exchange statement.
   Prefer incidents old enough that the facts cannot drift. Record every
   source's URL and publisher.
2. **Write the questions first.** Before calling anything, list what an
   investigator needs to know: who the attacker is, what was taken, how, where
   it went, who funded the attacker, which bridges carried it out, who else
   the same operator controls.
3. **Investigate.** Answer each question with the tools. Follow leads the way
   a real investigation would, and note the questions no tool answers.
4. **Find the mechanism**, for any incident that went through contract code
   (an exploit, a drainer package, a rug's mint or upgrade path). Do this
   before reading the post-mortem's root-cause section, so the tools, not the
   write-up, lead you there:
   - From the exploit transaction, name each Move call in order and what it
     changed (`analyze_attack_tx`, `get_transaction`, `decode_ptb`).
   - Read the functions it called: `get_move_function` for signatures and
     visibility, `disassemble_module` for bytecode, `decompile_module` for
     source-like output when `SUI_DECOMPILER_PATH` is set.
     `diff_package_upgrade` shows what a later version changed, which often
     is the fix.
   - State the flaw as the code shows it: which function, in which package
     version, lacks which check or computes what wrongly, and how the
     attacker's arguments reached it. Say what you read and what you infer.
   - Only then compare with the post-mortem, and grade the tools on whether
     they let you find the flaw and whether their output was readable enough
     to reason about.
5. **Grade each answer**:
   - `CORRECT`: matches the post-mortem or the chain.
   - `WRONG`: states something false.
   - `MISSING`: a fact inside the tool's scope is absent.
   - `MISLEADING`: true in its parts, but leads to a wrong conclusion.
   - `UNUSABLE`: an error, a timeout, or a result too large or unclear to use.
   - `GAP`: no tool answers the question.
6. **Write the case file** to `cases/README.md`'s format, named
   `<slug>.json`, with 8 to 20 checks. Each check pins one fact that cannot
   drift, from the post-mortem or the chain, and its `basis` says which. A
   mechanism fact read from a package's code (the function an exploit called,
   the check it lacks, the version that fixed it) is tier `code-derived`. A
   check on an answer the tool gets wrong keeps the correct expected value and
   gets `"known_defect": "<one line>"`. Validate and run it:

   ```bash
   SUI_CASES_DIR=<output directory> node scripts/probe/case-pass.mjs --case <slug>
   ```

   Every check passes or is `known`. A `FAIL` means the expectation is wrong,
   or the tool is wrong and the check needs `known_defect`.
7. **Write the report** (`report.md` in the output directory): the incident
   and its sources, then one entry per finding with its grade, the tool, the
   exact call, an output excerpt, the ground truth and a severity, then the
   mechanism (the flaw as the code shows it, how you found it, and whether it
   matches the post-mortem), then the questions no tool answers.

## Deliverables

- `<output directory>/<slug>.json`: the case file.
- `<output directory>/report.md`: the report.
- A final summary: the incident and its sources, the findings, the case file
  path, and the questions no tool answers.

A maintainer then copies the case into `cases/incidents/` and turns each
`WRONG`, `MISSING`, `MISLEADING` and `UNUSABLE` finding into a fix, as
`CONTRIBUTING.md` describes.
