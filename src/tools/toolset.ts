import { z } from "zod";
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
export function registerToolsetTool(
  server: McpServer,
  handles: ToolHandles,
  state: { active: Set<ProfileName> },
): void {
  const catalogue = PROFILE_NAMES.map(
    (p) => `'${p}' (${PROFILES[p].length} tools): ${PROFILE_SUMMARIES[p]}`,
  ).join(" | ");

  server.tool(
    "enable_tools",
    "Turn on additional Sui tool profiles for this session. This server ships a small default " +
      "tool surface and keeps the rest one call away, so start here whenever the capability you " +
      `need is not in your current tool list. Profiles: ${catalogue}. ` +
      "Use 'all' for everything. Newly enabled tools become callable immediately.",
    {
      profile: z
        .union([z.enum(PROFILE_NAMES as [ProfileName, ...ProfileName[]]), z.literal("all")])
        .describe("Profile to enable, or 'all'."),
    },
    async ({ profile }) => {
      if (profile === "all") {
        for (const p of PROFILE_NAMES) state.active.add(p);
      } else {
        state.active.add(profile);
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
                enabled_profile: profile,
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
