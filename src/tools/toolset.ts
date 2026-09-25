import { z } from "zod";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { errorResult } from "../utils/errors.js";
import {
  DEFAULT_PROFILES,
  PROFILES,
  PROFILE_NAMES,
  PROFILE_SUMMARIES,
  parseProfileList,
  toolsForProfiles,
  type ProfileName,
} from "./profiles.js";
import { toolPolicy } from "./tool-meta.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * The slice of the SDK's RegisteredTool we depend on. Narrowed to keep the
 * collector testable with a plain fake rather than a real server.
 */
export interface ToggleableTool {
  enable(): void;
  disable(): void;
  enabled?: boolean;
}

export type ToolHandles = Map<string, ToggleableTool>;

/**
 * Wrap a server so every `server.tool(...)` registration is recorded by name.
 *
 * Sits outside `withNetworkParam`, which already proxies `tool` and returns the
 * SDK's handle untouched, so the two compose. Registration order is unchanged;
 * this only observes.
 */
export function collectToolHandles(server: McpServer, handles: ToolHandles): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "tool") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        const handle = (target.tool as (...a: unknown[]) => unknown)(...args);
        const name = args[0];
        if (typeof name === "string" && isToggleable(handle)) {
          handles.set(name, handle);
        }
        return handle;
      };
    },
  });
}

function isToggleable(value: unknown): value is ToggleableTool {
  return (
    !!value &&
    typeof (value as ToggleableTool).enable === "function" &&
    typeof (value as ToggleableTool).disable === "function"
  );
}

/**
 * Answer a call to a disabled tool with the profile that holds it.
 *
 * The SDK replies "Tool trace_funds disabled", which names neither the profile
 * nor `enable_tools`, and a model reading it concludes the tool is broken. The
 * SDK's `tools/call` handler is installed when the first tool registers, so
 * this wraps `setRequestHandler` beforehand: calls to an enabled tool go
 * straight through, and a disabled one gets the hint without reaching the SDK.
 *
 * Call once, before any tool is registered on `server`.
 */
export function explainDisabledTools(server: McpServer, handles: ToolHandles): void {
  type Handler = (request: { params: { name: string } }, extra: unknown) => unknown;
  const inner = server.server;
  const setRequestHandler = inner.setRequestHandler.bind(inner) as (schema: unknown, handler: Handler) => void;
  inner.setRequestHandler = ((schema: unknown, handler: Handler) => {
    if (schema !== CallToolRequestSchema) return setRequestHandler(schema, handler);
    return setRequestHandler(schema, (request, extra) => {
      const name = request.params.name;
      if (handles.get(name)?.enabled !== false) return handler(request, extra);
      const profile = PROFILE_NAMES.find((p) => (PROFILES[p] as readonly string[]).includes(name));
      return errorResult(
        profile
          ? `${name} is in the '${profile}' profile, which is not enabled in this session. ` +
              `Call enable_tools({ profile: '${profile}' }), then call ${name} again.`
          : `${name} is disabled in this session. Call enable_tools({ profile: 'all' }), then call ${name} again.`,
      );
    });
  }) as typeof inner.setRequestHandler;
}

/**
 * Enable exactly the tools in `active`, disabling the rest.
 *
 * Tools registered but absent from every profile stay enabled: an unassigned
 * tool is a bookkeeping mistake, and hiding it would turn that mistake into a
 * silently missing feature. `test/profiles.test.ts` fails when one appears.
 */
export function applyProfiles(
  handles: ToolHandles,
  profiles: ProfileName[] | null,
  everyProfiledTool: Set<string>,
): { enabled: string[]; disabled: string[] } {
  const active = toolsForProfiles(profiles);
  const enabled: string[] = [];
  const disabled: string[] = [];

  for (const [name, handle] of handles) {
    const unassigned = !everyProfiledTool.has(name);
    if (active.has(name) || unassigned) {
      handle.enable();
      enabled.push(name);
    } else {
      handle.disable();
      disabled.push(name);
    }
  }
  return { enabled, disabled };
}

/** Claude Code cuts a tool description at this many characters. */
export const DESCRIPTION_LIMIT = 2048;

/**
 * The `enable_tools` description for the profiles active now.
 *
 * It names every tool of each profile that is off, because a disabled tool is
 * invisible and this text is the only way the model learns it exists: a
 * summary reading "DeepBook order book and fills" does not match a search for
 * `deepbook_trades`, and an agent that could not see a gated tool once
 * reimplemented it by hand. Profiles already on are named without their tools,
 * which the model can see in its list.
 *
 * Kept under {@link DESCRIPTION_LIMIT}: the text past it is cut, and the cut
 * part was the list of the last profiles. When the names do not fit, the
 * longest lists are replaced by a tool count, longest first.
 */
export function enableToolsDescription(active: ReadonlySet<ProfileName>): string {
  const head =
    "Turn on more Sui tool profiles for this session. When a tool you need is not in your list, call " +
    "this first: it is disabled, not missing. Do not rebuild a tool by hand. Pass `profile` or " +
    "`profiles`: one name, several, or 'all'. Enabled tools are callable at once.";
  const on = PROFILE_NAMES.filter((p) => active.has(p));
  const off = PROFILE_NAMES.filter((p) => !active.has(p));
  const status = on.length ? `On: ${on.join(", ")}.` : "";
  if (off.length === 0) return `${head}\n\n${status} Every profile is on.`;

  // A tool shared between profiles is listed once, and not at all when a
  // profile that is on already shows it.
  const shown = toolsForProfiles(on);
  const names: Partial<Record<ProfileName, string[]>> = {};
  for (const p of off) {
    names[p] = PROFILES[p].filter((t) => !shown.has(t));
    for (const t of names[p]) shown.add(t);
  }
  const counted = new Set<ProfileName>();
  const render = () =>
    [
      head,
      "",
      ...off.map((p) =>
        counted.has(p)
          ? `'${p}' (${PROFILE_SUMMARIES[p]}): ${PROFILES[p].length} tools`
          : `'${p}' (${PROFILE_SUMMARIES[p]}): ${names[p]!.join(", ")}`,
      ),
      status,
    ]
      .join("\n")
      .trimEnd();
  let text = render();
  const longestFirst = [...off].sort((a, b) => names[b]!.join(", ").length - names[a]!.join(", ").length);
  for (const p of longestFirst) {
    if (text.length <= DESCRIPTION_LIMIT) break;
    counted.add(p);
    text = render();
  }
  return text;
}

/**
 * Run `fn`, sending one `tools/list_changed` at the end instead of one per
 * tool it toggled. The SDK notifies from every `enable()`, so turning on
 * `forensics` sent one notification per tool.
 */
export function batchToolListChanged(server: McpServer, fn: () => void): void {
  const own = Object.prototype.hasOwnProperty.call(server, "sendToolListChanged");
  const original = server.sendToolListChanged;
  let changed = false;
  server.sendToolListChanged = () => {
    changed = true;
  };
  try {
    fn();
  } finally {
    if (own) server.sendToolListChanged = original;
    else delete (server as Partial<Pick<McpServer, "sendToolListChanged">>).sendToolListChanged;
  }
  if (changed) server.sendToolListChanged();
}

/**
 * One profile name, or several. Both are accepted wherever a profile is asked
 * for, in any case: 'Forensics' is the same request as 'forensics'.
 */
const profileName = z.preprocess(
  (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
  z.union([z.enum(PROFILE_NAMES as [ProfileName, ...ProfileName[]]), z.literal("all")]),
);
const profileArg = z.union([profileName, z.array(profileName)]);

/** Normalise either shape to a list. */
function toList(v: ProfileName | "all" | Array<ProfileName | "all"> | undefined): Array<ProfileName | "all"> {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Register the always-on profile switch.
 *
 * Registered on the raw server rather than the network-wrapped one: profiles
 * are not per-network, and injecting a `network` argument here would be noise.
 */
export function registerToolsetTool(
  server: McpServer,
  handles: ToolHandles,
  state: { active: Set<ProfileName> },
): void {
  const policy = toolPolicy("enable_tools");
  const self = server.registerTool(
    "enable_tools",
    {
      title: policy.title,
      description: enableToolsDescription(state.active),
      annotations: policy.annotations,
      inputSchema: {
        /**
         * Accepts one name or several, under either key.
         *
         * The tool is called `enable_tools`, so a caller guessing at its shape
         * reaches for `profiles: ["developer"]` — and a strict singular `profile`
         * rejected exactly that. The observed consequence was not a retry: the
         * model concluded the capability did not exist and hand-wrote GraphQL for
         * something a tool already did. Both keys and both shapes now work.
         */
        profile: profileArg
          .optional()
          .describe("Profile to enable, or 'all'. Accepts several: ['forensics','developer']."),
        profiles: profileArg
          .optional()
          .describe("Alias for `profile`. Same values; use whichever reads better."),
      },
    },
    async ({ profile, profiles }) => {
      const requested = [...new Set([...toList(profile), ...toList(profiles)])];
      if (requested.length === 0) {
        return errorResult(
          "Name at least one profile to enable, e.g. { profile: \"developer\" } or { profiles: [\"forensics\", \"developer\"] }. " +
            `Available: ${PROFILE_NAMES.join(", ")}, or 'all'.`,
        );
      }
      for (const req of requested) {
        if (req === "all") for (const p of PROFILE_NAMES) state.active.add(p);
        else state.active.add(req);
      }

      const active = toolsForProfiles([...state.active]);
      const turnedOn: string[] = [];
      batchToolListChanged(server, () => {
        for (const [name, handle] of handles) {
          if (active.has(name) && handle.enabled === false) {
            handle.enable();
            turnedOn.push(name);
          }
        }
        if (turnedOn.length) self.update({ description: enableToolsDescription(state.active) });
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                enabled_profiles: requested,
                active_profiles: [...state.active],
                newly_available_tools: turnedOn,
                note: turnedOn.length
                  ? "These tools are callable now."
                  : "Already enabled — no change.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

/**
 * The server's `instructions`, which a client may put in the model's context
 * once. Names the profiles, the tools an investigation turns on, and
 * `enable_tools`, since the tools that matter most start disabled.
 */
export function serverInstructions(): string {
  const profiles = PROFILE_NAMES.map((p) => `'${p}' (${PROFILE_SUMMARIES[p]})`).join("; ");
  return [
    "Read-only Sui analytics and forensics. Chain tools take an optional network: 'mainnet' (default), 'testnet' or 'devnet'.",
    "",
    `Tools come in profiles, and only some are on at the start: ${profiles}. When a tool you need is not in your list, call enable_tools with its profile, or 'all', before doing the work another way. A call to a disabled tool names the profile to enable.`,
    "",
    "For an investigation: identify_address first; trace_funds to follow value (read stop_reason and the unfollowed branches before the path); find_funding_source or find_funding_sources to attribute; get_address_fanout to measure a funder before trusting shared funding; build_wallet_edges to cluster; screen_address and classify_deposit_address for exposure and exchange deposits; analyze_attack_tx and summarize_incident_losses for exploits; resolve_bridge_transfer for cross-chain exits. Record conclusions with save_finding and render them with export_case.",
    "",
    "State the evidence tier of every claim: chain-derived, indexer-attested or heuristic. A cluster is heuristic, no edge is not evidence of no relation, and a trace that stopped does not mean the money stopped. The prompts investigate_address, trace_incident and attribute_cluster carry the full method.",
  ].join("\n");
}

/** Startup profile selection from the environment. */
export function startupProfiles(): ProfileName[] | null {
  return parseProfileList(process.env.SUI_TOOLS);
}

export { DEFAULT_PROFILES };
