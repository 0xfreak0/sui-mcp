import { readFileSync } from "node:fs";
import { z } from "zod";
import { markdownSections } from "./utils/markdown-sections.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Investigation prompts for clients without skills.
 *
 * Each prompt is a short task statement followed by the sections of the
 * forensics skill that govern that task, read from the skill file itself so the
 * method has one source. The skill ships in the npm package (`files` in
 * package.json), and `dist/` and `src/` both sit directly under the root, so
 * the same relative URL resolves from either.
 */
export const SKILL_URL = new URL("../.claude/skills/sui-forensics/SKILL.md", import.meta.url);

const TIERS = "Evidence tiers, and what each licenses";
const TOOLS = "Which tool answers what";
const REFUSE = "Conclusions to refuse";
const DONE = "When you are done";
const REPORT = "Reporting";

interface PromptSpec {
  title: string;
  description: string;
  /** The required argument naming what to investigate. `network` and `case_name` are common. */
  subject: { name: string; description: string };
  /** Skill sections the prompt carries, in order. */
  sections: string[];
  task: (args: Record<string, string | undefined>) => string;
}

const networkLine = (network?: string) => `Pass network: '${network || "mainnet"}' on every call.`;

const caseLine = (caseName?: string) =>
  caseName
    ? `Record each established claim with save_finding under case_name '${caseName}', and render the case with export_case at the end.`
    : "Record each established claim with save_finding under one case name, and render the case with export_case at the end.";

export const PROMPTS: Record<string, PromptSpec> = {
  investigate_address: {
    title: "Investigate a Sui address",
    description:
      "Work out what a Sui address is, where its money came from and went, and what can be claimed about it, following the sui-forensics method.",
    subject: { name: "address", description: "The address (0x…) or SuiNS name to investigate." },
    sections: [TIERS, "Opening a case", "The control question", "An address's rendering is not its identity", TOOLS, REFUSE, DONE, REPORT],
    task: ({ address, network, case_name }) =>
      [
        `Investigate the Sui address ${address}. ${networkLine(network)}`,
        "",
        "1. identify_address: is it a wallet, a package, an object or a multisig? A package or shared object is not a party.",
        "2. screen_address: exposure to exploiters, exchanges, bridges and sanctioned accounts, with hop distance.",
        "3. find_funding_source, then get_address_fanout on the funder before reading anything into it.",
        "4. get_transaction_history for its activity, and trace_funds from the transactions that matter. Read stop_reason and the unfollowed branches before the path.",
        "5. classify_deposit_address if the money reaches an exchange.",
        `6. ${caseLine(case_name)}`,
        "",
        "Say which evidence tier each claim rests on. The method follows.",
      ].join("\n"),
  },
  trace_incident: {
    title: "Trace a Sui incident",
    description:
      "Reconstruct an exploit or theft from its transaction or the attacker's address: what was taken, how, and where it went, following the sui-forensics method.",
    subject: { name: "subject", description: "An attack transaction digest, or the attacker's address." },
    sections: [
      TIERS,
      "Exploit transactions and incident losses",
      "Opening a case",
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
        "4. trace_funds forward from the attacker. Follow bridge_exits with resolve_bridge_transfer, and note every unfollowed branch.",
        "5. find_funding_source on the attacker to see who paid for the attack, and get_address_fanout on that funder.",
        `6. ${caseLine(case_name)}`,
        "",
        "Say which evidence tier each claim rests on. The method follows.",
      ].join("\n"),
  },
  attribute_cluster: {
    title: "Attribute a set of Sui addresses",
    description:
      "Assess whether several Sui addresses share an operator, with a control group and the evidence tier of each link, following the sui-forensics method.",
    subject: { name: "addresses", description: "Addresses to assess, comma-separated." },
    sections: [TIERS, "The control question", "What a cluster actually asserts", "Sponsorship", "Multisig", "Address aliases", TOOLS, REFUSE, REPORT],
    task: ({ addresses, network, case_name }) =>
      [
        `Assess whether these Sui addresses share an operator: ${addresses}. ${networkLine(network)}`,
        "",
        "1. identify_address on each; drop packages and shared objects from the set.",
        "2. find_funding_sources on the set: shared funders, co-funding with its denominators, subject_paid_subject and funding bursts.",
        "3. get_address_fanout on every shared funder. A service-scale funder carries no signal.",
        "4. sample_control_addresses and run the same test on the control group. Quote both numbers or neither.",
        "5. build_wallet_edges for the edges and clusters; read independent_intermediaries before the cluster. find_shared_multisig and analyze_multisig for committee links.",
        `6. ${caseLine(case_name)} A cluster is heuristic unless it rests on full-weight co_signer edges.`,
        "",
        "The method follows.",
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

export function registerAllPrompts(server: McpServer): void {
  for (const [name, spec] of Object.entries(PROMPTS)) {
    const argsSchema = {
      [spec.subject.name]: z.string().describe(spec.subject.description),
      network: z.string().optional().describe("mainnet (default), testnet or devnet."),
      case_name: z.string().optional().describe("Case to record findings under."),
    };
    server.registerPrompt(name, { title: spec.title, description: spec.description, argsSchema }, (args) => ({
      description: spec.description,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `${spec.task(args)}\n\n${skillText(spec.sections)}`,
          },
        },
      ],
    }));
  }
}
