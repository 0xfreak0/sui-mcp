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

/**
 * Register the always-on profile switch.
 *
 * Registered on the raw server rather than the network-wrapped one: profiles
 * are not per-network, and injecting a `network` argument here would be noise.
 *
 * Its description lists every profile and what each contains, because a
 * disabled tool is invisible — this text is the only way the model can learn
 * that the capability it needs exists somewhere.
 */
/** One profile name, or several. Both are accepted wherever a profile is asked for. */
const profileName = z.union([
  z.enum(PROFILE_NAMES as [ProfileName, ...ProfileName[]]),
  z.literal("all"),
]);
const profileArg = z.union([profileName, z.array(profileName)]);

/** Normalise either shape to a list. */
function toList(v: unknown): Array<ProfileName | "all"> {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]) as Array<ProfileName | "all">;
}

export function registerToolsetTool(
  server: McpServer,
  handles: ToolHandles,
  state: { active: Set<ProfileName> },
): void {
  // Tool NAMES, not just prose. A summary reading "DeepBook order book and
  // fills" does not match a search for `deepbook_trades`, and an agent that
  // can't see a disabled tool has only this text to learn it exists — one
  // reimplemented a gated tool from scratch rather than enabling it. The extra
  // ~250 tokens buy back the whole point of the gate.
  const catalogue = PROFILE_NAMES.map(
    (p) => `'${p}' — ${PROFILE_SUMMARIES[p]}. Tools: ${PROFILES[p].join(", ")}`,
  ).join("\n");

  server.tool(
    "enable_tools",
    "Turn on additional Sui tool profiles for this session. This server ships a small default " +
      "tool surface and keeps the rest one call away. Call this FIRST whenever the capability " +
      "you need is not in your current tool list — the tool probably exists and is simply " +
      "disabled. Do not reimplement a listed tool by hand.\n\n" +
      `${catalogue}\n\n` +
      "Use 'all' for everything. Newly enabled tools are callable immediately.",
    {
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
    async ({ profile, profiles }) => {
      const requested = [
        ...new Set([...toList(profile), ...toList(profiles)]),
      ];
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
      for (const [name, handle] of handles) {
        if (active.has(name) && handle.enabled === false) {
          handle.enable();
          turnedOn.push(name);
        }
      }

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

/** Startup profile selection from the environment. */
export function startupProfiles(): ProfileName[] | null {
  return parseProfileList(process.env.SUI_TOOLS);
}

export { DEFAULT_PROFILES };
