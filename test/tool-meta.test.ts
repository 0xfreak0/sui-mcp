import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { withStructuredContent } from "../src/tools/tool-meta.js";
import { DESCRIPTION_LIMIT, enableToolsDescription } from "../src/tools/toolset.js";
import { PROFILES, PROFILE_NAMES, type ProfileName } from "../src/tools/profiles.js";
import { PROMPTS, SKILL_URL } from "../src/prompts.js";
import { markdownSections } from "../src/utils/markdown-sections.js";

const text = (t: string) => ({ type: "text", text: t });

describe("withStructuredContent", () => {
  it("takes the JSON item that follows a prose summary", () => {
    const res = withStructuredContent({ content: [text("FUND TRACE — FORWARD\n…"), text('{"hops":[]}')] });
    expect(res.structuredContent).toEqual({ hops: [] });
    expect(res.content).toHaveLength(2);
  });

  it("leaves errors, arrays and prose alone", () => {
    expect(withStructuredContent({ content: [text('{"error":"x"}')], isError: true }).structuredContent).toBeUndefined();
    expect(withStructuredContent({ content: [text("[1,2]")] }).structuredContent).toBeUndefined();
    expect(withStructuredContent({ content: [text("# Report")] }).structuredContent).toBeUndefined();
  });
});

describe("enable_tools description", () => {
  const subsets: ProfileName[][] = [];
  for (let mask = 0; mask < 1 << PROFILE_NAMES.length; mask++) {
    subsets.push(PROFILE_NAMES.filter((_, i) => mask & (1 << i)));
  }

  // Claude Code cuts the rest, and what it cut was the last profiles' tools.
  it.each(subsets.map((s) => [s.join(",") || "(none)", s] as const))("fits the limit with %s on", (_l, on) => {
    expect(enableToolsDescription(new Set(on)).length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
  });

  it("names every tool the model cannot see when the names fit", () => {
    const d = enableToolsDescription(new Set<ProfileName>(["core"]));
    const hidden = PROFILE_NAMES.filter((p) => p !== "core").flatMap((p) => PROFILES[p]);
    expect(hidden.filter((t) => !d.includes(t))).toEqual([]);
  });
});

describe("prompts", () => {
  // A renamed skill heading would drop that part of the method from the prompt.
  it("carry only skill sections that exist", () => {
    const skill = readFileSync(SKILL_URL, "utf8");
    for (const [name, spec] of Object.entries(PROMPTS)) {
      expect(markdownSections(skill, spec.sections).missing, name).toEqual([]);
    }
  });
});

describe("markdownSections", () => {
  const md = [
    "# Title",
    "intro",
    "## One",
    "a",
    "### Sub",
    "b",
    "```",
    "## not a heading",
    "```",
    "## Two",
    "c",
  ].join("\n");

  it("returns sections in the order asked, with subsections and fenced lines", () => {
    const { text: out, missing } = markdownSections(md, ["Two", "One", "Three"]);
    expect(out).toBe("## Two\nc\n\n## One\na\n### Sub\nb\n```\n## not a heading\n```");
    expect(missing).toEqual(["Three"]);
  });
});
