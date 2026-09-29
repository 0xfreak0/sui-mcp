import { readFileSync } from "node:fs";
import { z } from "zod";
import { markdownSections } from "./utils/markdown-sections.js";
import { GetPromptRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Prompts for clients without skills.
 *
 * Each prompt is a short task statement followed by the sections of the
 * forensics skill that govern that task, read from the skill file itself so the
 * method has one source. The skill ships in the npm package (`files` in
 * package.json), and `dist/` and `src/` both sit directly under the root, so
 * the same relative URL resolves from either.
 *
 * The investigation prompts carry the method at length. The everyday prompts
 * answer one question a non-investigator asks, so they carry at most one short
 * section and name each tool call as `tool_name(arg, arg: value)`, which the
 * tests check against the registered tools' schemas.
 */
export const SKILL_URL = new URL("../.claude/skills/sui-forensics/SKILL.md", import.meta.url);

const TIERS = "Evidence tiers, and what each licenses";
const TOOLS = "Which tool answers what";
const REFUSE = "Conclusions to refuse";
const DONE = "When you are done";
const REPORT = "Reporting";
const MECHANISM = "Finding the flaw in the code";

interface PromptArg {
  name: string;
  description: string;
  required: boolean;
}

interface PromptSpec {
  title: string;
  description: string;
  /** Arguments besides `network`, which every prompt takes. */
  args: PromptArg[];
  /** Skill sections the prompt carries, in order. */
  sections: string[];
  task: (args: Record<string, string | undefined>) => string;
}

const CASE_ARG: PromptArg = { name: "case_name", description: "Case to record findings under.", required: false };

const networkLine = (network?: string) => `Pass network: '${network || "mainnet"}' on every call.`;

const caseLine = (caseName?: string) =>
  caseName
    ? `Record each established claim with save_finding under case_name '${caseName}', and render the case with export_case at the end.`
    : "Record each established claim with save_finding under one case name, and render the case with export_case at the end.";

/**
 * How an everyday prompt answers. The reader is not an investigator, so the
 * answer they can act on comes first and the evidence after it.
 */
const EVERYDAY_ANSWER = [
  "Answer in this order:",
  "1. The plain answer: 2 to 4 sentences with no jargon, which someone new to crypto can act on.",
  "2. One line `How sure: high|medium|low`, then one sentence naming the evidence it rests on and what was not checked. High means chain data answers the question directly; medium means it rests on a label, a blocklist or a heuristic; low means a read the answer depends on failed, was skipped or found nothing.",
  "3. The key evidence: the digests and addresses behind the answer, one short line each.",
  "",
  "Rules:",
  "- A flag (a label, a blocklist entry, a lookalike pair, a risk note, a bytecode lead) is a lead, not a verdict. Say so when you report one.",
  "- An empty result clears nothing. No flag found means none was found in what was read, never that the subject is safe.",
  "- Never name or guess the real-world identity of a private person. Name only an organisation that a label names with its source, such as an exchange, a protocol or a bridge.",
  "- Keep tokens low: keep each tool's default detail level, never ask for detail: 'full', and skip a step marked optional unless the answer depends on it.",
].join("\n");

/** The line for steps that need a tool outside the default profile. */
const enableLine = (...profiles: Array<"forensics" | "developer">) =>
  `Steps marked ${profiles.map((p) => `(${p})`).join(" or ")} use tools outside the default set. When you reach the first step of a profile and its tool is missing from your list, enable that profile once: ${profiles.map((p) => `\`enable_tools(profile: '${p}')\``).join(" or ")}. Enabling a profile adds its tools to every later request, so do not enable it for a step you skip.`;

export const PROMPTS: Record<string, PromptSpec> = {
  investigate_address: {
    title: "Investigate a Sui address",
    description:
      "Work out what a Sui address is, where its money came from and went, and what can be claimed about it, following the sui-forensics method.",
    args: [{ name: "address", description: "The address (0x…) or SuiNS name to investigate.", required: true }, CASE_ARG],
    sections: [TIERS, "Opening a case", "The control question", "An address's rendering is not its identity", TOOLS, REFUSE, DONE, REPORT],
    task: ({ address, network, case_name }) =>
      [
        `Investigate the Sui address ${address}. ${networkLine(network)}`,
        "",
        "1. identify_address: is it a wallet, a package, an object or a multisig? A package or shared object is not a party.",
        "2. get_wallet_overview with include_prices: what it holds, what the total leaves out (`coverage`), and `leads`: a shared vault whose fields name it (a bot trading through one moves no balance of its own) or a position near its borrow limit.",
        "3. screen_address: exposure to exploiters, exchanges, bridges and sanctioned accounts, with hop distance.",
        "4. find_funding_source, then get_address_fanout on the funder before reading anything into it.",
        "5. summarize_address_flows over the window that matters: per-asset totals, every payer, the top recipients and every bridge exit with its beneficiary. Then trace_funds from the transactions that matter, or trace_flow_graph when the question is where all of it went. Read stop_reason and the unfollowed branches before the path.",
        "6. classify_deposit_address if the money reaches an exchange.",
        `7. ${caseLine(case_name)}`,
        "",
        "Say which evidence tier each claim rests on. The method follows.",
      ].join("\n"),
  },
  trace_incident: {
    title: "Trace a Sui incident",
    description:
      "Reconstruct an exploit or theft from its transaction or the attacker's address: what was taken, how, and where it went, following the sui-forensics method.",
    args: [{ name: "subject", description: "An attack transaction digest, or the attacker's address.", required: true }, CASE_ARG],
    sections: [
      TIERS,
      "Exploit transactions and incident losses",
      "Opening a case",
      "Packages: who deployed it, and who can change it",
      MECHANISM,
      "What a balance change does not show",
      TOOLS,
      "Traps in the data itself",
      REFUSE,
      DONE,
      REPORT,
    ],
    task: ({ subject, network, case_name }) =>
      [
        `Reconstruct the incident starting from ${subject}. ${networkLine(network)}`,
        "",
        "1. If it is a digest: analyze_attack_tx for per-address net in USD at the time, flash-loan legs, pool price moves and oracle touches. If it is an address: get_transaction_history and query_transactions for the attack window, then analyze_attack_tx on each attack transaction.",
        "2. summarize_incident_losses over the attack digests for per-pool losses and a USD total; list the coins it could not price.",
        "3. manage_labels for the exchanges and bridges already known, so traces stop at them.",
        "4. summarize_address_flows on the attacker over the incident window for what left Sui and to whom, then trace_flow_graph from an attack transaction for every branch. Follow bridge exits with resolve_bridge_transfer, and note every unfollowed branch.",
        "5. find_funding_source on the attacker to see who paid for the attack, get_address_fanout on that funder, and classify_deposit_address if it looks like an exchange.",
        "6. If a protocol's own code was exploited, find the flaw from the exploit, not from the upgrade list: decode_ptb with digest for each call's arguments (commands: [i, j] for the calls analyze_attack_tx flags; get_transaction with detail 'full' is several times larger); get_upgrade_history with as_of the attack time for the version live then and who could upgrade; get_move_function, then disassemble_module with function_name, on each called function at the address the transaction called; the dependency version it linked, since the flaw can sit in one: the note on each dependency's use line in disassemble_module, or get_package dependencies, gives the ID to read (get_package_dependency_graph for dependencies of dependencies). Then diff_package_upgrade on the fix (a later version or a relink) and on the version that introduced the code, if either exists. Say what you read in the code and what you inferred.",
        "7. If the calls ran an older version of a lineage (stale-package-version), read that version's gate with disassemble_module function_name: older versions stay callable against the shared objects newer ones manage unless they check a version number. For each shared object the exploit changed, query_transactions with affected_object lists the transactions that touched it, setup included, and get_object with version reads its state before and between steps (each transaction's object_changes in get_transaction detail 'full' give the version it left the object at).",
        `8. ${caseLine(case_name)}`,
        "",
        "Say which evidence tier each claim rests on. The method follows.",
      ].join("\n"),
  },
  attribute_cluster: {
    title: "Attribute a set of Sui addresses",
    description:
      "Assess whether several Sui addresses share an operator, with a control group and the evidence tier of each link, following the sui-forensics method.",
    args: [{ name: "addresses", description: "Addresses to assess, comma-separated.", required: true }, CASE_ARG],
    sections: [TIERS, "The control question", "What a cluster actually asserts", "Sponsorship", "Multisig", "Address aliases", TOOLS, REFUSE, REPORT],
    task: ({ addresses, network, case_name }) =>
      [
        `Assess whether these Sui addresses share an operator: ${addresses}. ${networkLine(network)}`,
        "",
        "1. identify_address on each; drop packages and shared objects from the set.",
        "2. find_funding_sources on the set: shared funders, co-funding with its denominators, subject_paid_subject and funding bursts.",
        "3. get_address_fanout on every shared funder. A service-scale funder carries no signal.",
        "4. sample_control_addresses and run the same test on the control group. Quote both numbers or neither.",
        "5. build_wallet_edges for the edges and clusters; read independent_intermediaries before the cluster. find_shared_multisig and analyze_multisig for committee links. find_flow_path between two members for a direct value path.",
        `6. ${caseLine(case_name)} A cluster is heuristic unless it rests on full-weight co_signer edges.`,
        "",
        "The method follows.",
      ].join("\n"),
  },
  was_i_scammed: {
    title: "Was I scammed?",
    description:
      "For someone who thinks they lost funds: what left the wallet, where it went, whether a known drainer or a lookalike address was involved, and what to do next.",
    args: [
      { name: "address", description: "Your wallet address (0x…) or SuiNS name.", required: false },
      { name: "digest", description: "The digest of the transaction you suspect.", required: false },
    ],
    sections: [],
    task: ({ address, digest, network }) =>
      [
        address || digest
          ? `Work out whether the user lost funds to a scam, from ${[address && `their wallet ${address}`, digest && `the transaction ${digest}`].filter(Boolean).join(" and ")}. ${networkLine(network)}`
          : "The user thinks they were scammed but gave neither a wallet address nor a transaction digest. Ask for either one, and wait for the answer before calling any tool.",
        enableLine("forensics"),
        "",
        "1. Find the transaction. With a digest, go to step 2. With only a wallet, `get_transaction_history(address, limit: 20)` lists its recent transactions, newest first: look for value leaving that the user did not expect, and read `address_poisoning` for a lookalike of an address the user pays. When several transactions fit, ask the user which one.",
        "2. What moved: `get_transaction(digest)`. `balance_changes` gives the coins each address lost or gained, and `object_transfers` each object that changed hands (an NFT, staked SUI, a capability such as a KioskOwnerCap or an AdminCap) and where it went. `authorization` says who signed. The user's wallet is the address they gave. With only a digest, it is the address that lost coins or objects beyond gas here, never the sender by default; when that address sent the same coin or NFT to several addresses (a drop), or no address lost anything beyond gas, ask the user which address is theirs before going on.",
        "   - When the wallet only received something (an unknown coin or NFT) and lost nothing but gas, nothing was taken in this transaction. For a coin, `analyze_token(query, include_holders: false)` gives `flagged_by`; for an NFT, `identify_address(address)` on its object id does. Tell the user not to follow a link or claim made in its name, then answer and skip steps 3 to 5.",
        "   - When it is a plain transfer the user sent to an address they believed they knew, check for address poisoning: `get_transaction_history(address, limit: 20)` on the user's wallet compares every address on that page in `address_poisoning`, and the user can compare the address they meant to pay with the recipient in full.",
        "3. Drainer check (forensics): `analyze_attack_tx(digest)`. In `anomalies`, `blocklisted-package-call` means the transaction called a package on the Sui wallet scam blocklist, and `transfers-to-non-sender` names the coins and objects it handed to another address.",
        "4. Standing access: `identify_address(address)` on the user's wallet. Sui has no ERC-20 style allowance: an owned coin or object moves only in a transaction the owner's account authorizes, with its own key or through an address in its alias set. `delegated_to` lists those addresses, and one the user did not add can still move what is left.",
        "5. Where it went (forensics): `trace_funds(digest, direction: 'forward', hops: 5)` follows the largest flow hop by hop. Read `address_poisoning` and `stop_reason`: an exchange, a bridge exit, a hub, an address that has not moved the funds yet, or the hop limit. The hop limit means the funds kept moving: trace again from the last hop's transaction before saying where they went. At a bridge exit, `resolve_bridge_transfer(digest)` names the account on the other chain. When the trace stops at an exchange, `classify_deposit_address(address)` on the last address before it says whether that is the exchange's deposit address. Optional: `screen_address(address, direction: 'out')` on the first recipient for its exposure to labelled scam, exchange and bridge accounts.",
        "6. What the user can do: keep every digest above; report to the exchange the funds reached, with the deposit address and the digests; if the user did not approve the transaction that took the funds, treat the wallet's key as exposed and move what is left to a new wallet; and if `delegated_to` names an address the user did not add, that address can still move funds.",
        "",
        EVERYDAY_ANSWER,
      ].join("\n"),
  },
  is_this_token_safe: {
    title: "Is this token a rug?",
    description:
      "For someone deciding whether to buy or hold a coin: who can mint or freeze it, whether its code can change, who holds it, whether it trades, and whether a scam list flags it.",
    args: [{ name: "coin_type", description: "The coin type (0x…::module::NAME). A symbol works but may match several coins.", required: true }],
    sections: ["A holder scan is not a ranking unless it finished"],
    task: ({ coin_type, network }) =>
      [
        `Assess whether the coin ${coin_type} carries the risks of a rug pull, for a user deciding whether to buy or hold it. ${networkLine(network)}`,
        enableLine("developer", "forensics"),
        "",
        "1. `analyze_token(query)`: `verified` (a curated list names this coin type as the real coin for its symbol; it says nothing about who controls or holds it), `flagged_by` (the Sui wallet scam blocklist), supply, price, `deny_list`, and a sample of holders. A symbol several coins use returns `candidates`: ask the user which coin type they mean, and never pick one for them.",
        "2. Who can mint and change it (developer): `analyze_package(package_id)` on the coin's package, the part of the coin type before the first `::`. In `capabilities`, the TreasuryCap's `owner` and `note` say who can mint:",
        "   - an address: that holder can mint at will; shared: anyone can; sent to an address nobody holds a key for: nobody can;",
        "   - frozen (immutable): nobody can mint, though its name, symbol and icon may still change;",
        "   - burned (destroyed): nobody can only when the note says the coin registry records the supply as fixed or burn-only; otherwise whatever holds the supply still can;",
        "   - wrapped, or held by another object (`owner` object, the holder named in `owner_address` and its type in `owner_type`): the rules of the contract holding it decide;",
        "   - named under `coins_without_located_mint_authority`: its `risk` decides. At `info` nobody can mint (the registry records a fixed or burn-only supply, or the coin is SUI); at `medium` the audit could not find the TreasuryCap, so say who can mint is unknown, never that nobody can;",
        "   - not listed anywhere: the audit could not find it. Say who can mint is unknown, never that nobody can.",
        "   The `findings` entry `mint-authority` names the package's public functions that mint or take the TreasuryCap, and `freeze-authority` its deny list functions. A DenyCap's holder can freeze addresses. The UpgradeCap's `owner` and `note` say whether the code can still change: burned, frozen or sent to an address nobody holds a key for, never; shared, anyone can upgrade; wrapped or held by another object, the rules of the contract holding it; an address, that holder, and an upgrade can add functions that use the caps the package's own objects hold. Read `flagged_by` and `root_publisher` too.",
        "   A coin type names its package's first version, so `findings` describe that version's code. When `lineage.latest_version` is above `lineage.version`, `identify_address(address)` on the package gives `lineage.latest_package_id`, and `analyze_package(package_id, audit_capabilities: false)` on that id reads the current code; if you skip it, say the current code's mint functions were not read.",
        "3. Optional: when an address holds the TreasuryCap, the DenyCap or the UpgradeCap, `identify_address(address)` on it says whether that power sits with one key or a multisig committee, and whether a label names the holder.",
        "4. Freezes (forensics, only when `deny_list` says the coin is regulated): `check_coin_restrictions(coin_type)` lists the frozen addresses and whether the coin is paused.",
        "5. Holders (forensics, optional when step 1's sample already answers it): `get_top_holders(type, limit: 10)`. Quote a share of supply only when `complete_ranking` is true. A holder with `owner_kind` object is a contract object, such as a pool or a vault, not a person. The deployer or its funder holding most of the supply is a lead to report.",
        "6. Liquidity: `find_pools(token_a, token_b: 'SUI')` searches Cetus, DeepBook and Turbos. No pool there leaves every other venue unchecked.",
        "7. Deployer: `identify_address(address)` on `root_publisher` for its age (`first_seen`) and any label. Optional: `get_transaction_history(address, limit: 10)` on it, to see whether it recently sold or moved the coin.",
        "",
        "In the plain answer, say who can mint more, freeze holders or change the code (one key, a committee of N with threshold M, anyone, the rules of the contract that holds the cap, nobody, or unknown), and how concentrated the holdings are.",
        "",
        EVERYDAY_ANSWER,
      ].join("\n"),
  },
  is_this_protocol_safe: {
    title: "Is this protocol safe?",
    description:
      "For someone deciding whether to deposit into a protocol: who can upgrade its code or use its admin powers, whether that changed recently, and what its bytecode scan flags.",
    args: [{ name: "protocol", description: "A package ID (0x…), an MVR name (@org/app), or a protocol name such as Cetus.", required: true }],
    sections: [],
    task: ({ protocol, network }) =>
      [
        `Assess who controls the protocol or package ${protocol}, for a user deciding whether to deposit into it. ${networkLine(network)}`,
        enableLine("forensics"),
        "",
        "1. Given a protocol name rather than a package ID (forensics): `resolve_protocol_packages(protocol)` lists the package versions of that protocol that emit events now. Continue with the one or two the user would call. An MVR name (@org/app) can be passed wherever a package is asked for.",
        "2. Upgrade authority (forensics): `get_upgrade_history(package)`. `upgrade_cap` gives its `state` (exists, deleted, wrapped or unknown) and `current_holder`: an address with its signing `scheme` (one key, or a multisig with its threshold), shared (anyone can upgrade), immutable (frozen: nobody can) or an object (the rules of the contract holding it decide). Deleted, or sent to an address nobody holds a key for, means the code can no longer change, which lowers the risk, and so does a deleted cap with no `object_id`: the publish itself destroyed it; wrapped means the rules of the contract holding it decide; unknown means it could not be read, never that nobody holds it. Read the most recent entries of `versions` (when the code last changed and who signed) and `flags`: a cap round trip, a single-key upgrade while the cap is usually multisig-held, a policy change, or a cap destroyed, wrapped, frozen or shared.",
        "3. Admin powers (forensics): `analyze_package(package_id)` on the newest version. `capabilities` lists the admin caps with each holder, owner kind and risk note; a cap with owner `consensus` is held by its one owner address. `upgrade_cap` gives `owner_change_count` and `last_owner_change`; `flagged_by` is the Sui wallet scam blocklist. The `bytecode_scan` leads are hints for a reviewer, graded strong, medium or weak, and never evidence of a flaw by themselves.",
        "4. For each address holding the UpgradeCap or an admin cap, `identify_address(address)`: a multisig committee and its members, a label, or one key. Optional: `analyze_multisig(address)` (forensics) says which committee keys actually sign.",
        "5. Optional: `trace_object_history(object_id, order: 'newest', limit: 10)` (forensics) on the UpgradeCap or an admin cap lists its recent owner changes.",
        "6. Past incidents: this server keeps no incident list for a protocol. Mention an incident only with a source you can cite, such as the protocol's own post-mortem; otherwise say past incidents were not checked.",
        "",
        "In the plain answer, say who can change the code or use the admin powers (one key, a committee of N with threshold M, anyone, the rules of the contract that holds the cap, nobody, or unknown) and whether that changed recently.",
        "",
        EVERYDAY_ANSWER,
      ].join("\n"),
  },
  who_is_this_wallet: {
    title: "Who is this wallet?",
    description:
      "For someone deciding whether to trust or pay an address: what kind of account it is, what labels it carries and on what evidence, how it is funded and used, and whether it behaves like an exchange deposit address.",
    args: [{ name: "address", description: "The address (0x…) or SuiNS name.", required: true }],
    sections: [],
    task: ({ address, network }) =>
      [
        `Describe what the Sui account ${address} is, for a user deciding whether to trust or pay it. ${networkLine(network)}`,
        enableLine("forensics"),
        "",
        "1. `identify_address(address)`, which takes a SuiNS name too. `type` says what it is: a wallet, a package, an object or a validator (for a package, the is_this_protocol_safe prompt answers the rest; for an object, say what it is and stop). Read:",
        "   - the `label` with its `source` and `evidence`;",
        "   - `sui_name` and `names_held`: handles anyone can buy, never identity, and a name another address sent it (`provenance` received_from_third_party) says nothing about the holder;",
        "   - `authentication`: one key, a `multisig` committee, `zklogin` or `passkey`. Null means it has never sent a transaction, so how it signs is unknown. A committee is fixed by the address; a member marked `unsignable` can never sign;",
        "   - `delegated_to`: other addresses that can act for it, whatever its committee;",
        "   - `first_seen`: its age.",
        "2. `get_transaction_history(address, limit: 10)`: what it does (protocols, actions, how recent) and `address_poisoning`.",
        "3. Optional: `get_wallet_overview(address)` when what it holds matters to the question.",
        "4. Funding (forensics): `find_funding_source(address)` walks back to who first funded it and stops at a labelled exchange or a service. Funding from an exchange means the owner used that exchange; it names nobody.",
        "5. Exchange deposit behaviour (forensics, when the history shows it sending its whole balance to one address): `classify_deposit_address(address)` says whether it is an exchange's deposit address, with the exchange's label and source.",
        "6. Optional (forensics): `screen_address(address)` for exposure to labelled scam, sanctioned, exchange and bridge accounts within two hops; `summarize_address_flows(address)` for its main counterparties with their labels; `analyze_multisig(address)` for which keys of a multisig actually sign.",
        "",
        "In the plain answer, describe it by what the data shows: an exchange wallet or deposit address (with the label's source), a protocol or bridge account, a multisig treasury, or an unlabelled wallet with its age and activity.",
        "",
        EVERYDAY_ANSWER,
      ].join("\n"),
  },
};

/** The skill sections a prompt carries. Throws when the skill file is not where it ships. */
export function skillText(sections: string[]): string {
  let markdown: string;
  try {
    markdown = readFileSync(SKILL_URL, "utf8");
  } catch (err) {
    throw new Error(`The forensics skill is not readable at ${SKILL_URL.pathname}: ${(err as Error).message}`);
  }
  return markdownSections(markdown, sections).text;
}

/**
 * `prompts/get` with no `arguments` field reaches a prompt as `{}`.
 *
 * The protocol makes the field optional, but the SDK validates it against the
 * prompt's object schema, so a prompt whose arguments are all optional would be
 * refused rather than rendered. The SDK installs its handler when the first
 * prompt registers, so this wraps `setRequestHandler` beforehand, the same way
 * `explainDisabledTools` wraps `tools/call`.
 */
function defaultPromptArguments(server: McpServer): void {
  type Handler = (request: { params: { arguments?: Record<string, string> } }, extra: unknown) => unknown;
  const inner = server.server;
  const setRequestHandler = inner.setRequestHandler.bind(inner) as (schema: unknown, handler: Handler) => void;
  inner.setRequestHandler = ((schema: unknown, handler: Handler) => {
    if (schema !== GetPromptRequestSchema) return setRequestHandler(schema, handler);
    return setRequestHandler(schema, (request, extra) =>
      handler({ ...request, params: { ...request.params, arguments: request.params.arguments ?? {} } }, extra),
    );
  }) as typeof inner.setRequestHandler;
}

export function registerAllPrompts(server: McpServer): void {
  defaultPromptArguments(server);
  for (const [name, spec] of Object.entries(PROMPTS)) {
    const argsSchema: Record<string, z.ZodString | z.ZodOptional<z.ZodString>> = {};
    for (const arg of spec.args) {
      argsSchema[arg.name] = arg.required ? z.string().describe(arg.description) : z.string().optional().describe(arg.description);
    }
    argsSchema.network = z.string().optional().describe("mainnet (default), testnet or devnet.");
    server.registerPrompt(name, { title: spec.title, description: spec.description, argsSchema }, (args) => ({
      description: spec.description,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: spec.sections.length > 0 ? `${spec.task(args)}\n\n${skillText(spec.sections)}` : spec.task(args),
          },
        },
      ],
    }));
  }
}
