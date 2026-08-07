import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registerAllTools } from "../src/tools/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));

const pkg = readJson("package.json");
const serverJson = readJson("server.json");
const readme = readFileSync(join(root, "README.md"), "utf8");
const indexSrc = readFileSync(join(root, "src/index.ts"), "utf8");

/**
 * Every capability tool `registerAllTools` registers. Uses the same
 * recording-fake technique as with-network.test.ts: the real McpServer would
 * need a transport, and all we want is the registration list.
 *
 * `enable_tools` is excluded. It is the profile switch, not a Sui capability,
 * and counting it would inflate the number the README and package description
 * advertise. See src/tools/profiles.ts.
 */
function registeredToolNames(): string[] {
  const names: string[] = [];
  const fake = {
    tool(...args: unknown[]) {
      names.push(args[0] as string);
      return { enabled: true, enable() {}, disable() {} };
    },
  } as unknown as McpServer;
  registerAllTools(fake);
  return names.filter((n) => n !== "enable_tools");
}

describe("npm tarball contents", () => {
  // .gitignore lists `dist/`, and npm falls back to .gitignore when there is no
  // .npmignore. Without an explicit `files` allowlist the published tarball
  // would therefore contain no build output at all — the package would install
  // and then fail at `node dist/index.js`. This test is the guard on that.
  it("ships dist/ via an explicit files allowlist", () => {
    expect(pkg.files).toContain("dist");
  });

  it("does not ship the vendored decompiler sources or its binary", () => {
    // revela_sui/ is ~700MB of cloned Rust and bin/move-decompiler is a
    // platform-specific build; neither may leak into the tarball.
    expect(pkg.files).not.toContain("bin");
    expect(pkg.files).not.toContain("revela_sui");
  });

  it("points bin at a build artifact that carries a shebang", () => {
    // `npx <pkg>` execs the bin directly, so the shebang has to survive tsc.
    // It does, because it's the first line of src/index.ts; the executable bit
    // is applied by the build script (`chmod +x dist/index.js`).
    expect(indexSrc.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(pkg.scripts.build).toContain("chmod +x dist/index.js");

    const binTargets = Object.values(pkg.bin as Record<string, string>);
    expect(binTargets).toHaveLength(1);
    expect(binTargets[0]).toBe("./dist/index.js");
  });

  it("names the bin after the package so `npx <pkg>` is unambiguous", () => {
    expect(Object.keys(pkg.bin as Record<string, string>)).toEqual([pkg.name]);
  });

  // The checks above read intent out of package.json; this one asks npm what it
  // would actually ship. `npm pack --dry-run` writes no tarball and needs no
  // registry credentials, so it is safe to run in CI.
  it("actually resolves to a tarball with the entrypoint and no vendored binary", () => {
    // npm pack reports what is on disk, so this needs a build to have happened.
    // Without the explicit check the failure reads as "dist/index.js missing
    // from the tarball", which points at the files allowlist rather than at the
    // real cause.
    if (!existsSync(join(root, "dist/index.js"))) {
      throw new Error("dist/ not built — run `npm run build` before `npm test`");
    }

    const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);

    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("package.json");
    // Loaded at runtime by src/utils/labels.ts, so the build's data copy step
    // has to land in the tarball or fund tracing loses its curated labels.
    expect(paths).toContain("dist/data/labeled-addresses.json");

    expect(paths.some((p) => p.startsWith("bin/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("revela_sui/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("src/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("test/"))).toBe(false);
    // Source and declaration maps point at ../src, which is not published;
    // shipping them would only add dangling references.
    expect(paths.some((p) => p.endsWith(".map"))).toBe(false);
  }, 30_000);
});

describe("MCP registry metadata", () => {
  // The registry proves package ownership by fetching the npm package and
  // checking package.json's `mcpName` against server.json's `name`. A mismatch
  // is a publish-time rejection, not a warning.
  it("package.json mcpName matches the server.json name", () => {
    expect(pkg.mcpName).toBe(serverJson.name);
  });

  it("uses a GitHub-authenticated namespace", () => {
    // `mcp-publisher login github` only grants io.github.<username>/* .
    expect(serverJson.name).toMatch(/^io\.github\.[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/);
  });

  it("server.json points at the package this repo publishes", () => {
    const [npmPackage] = serverJson.packages;
    expect(npmPackage.registryType).toBe("npm");
    expect(npmPackage.identifier).toBe(pkg.name);
    expect(npmPackage.registryBaseUrl).toBe("https://registry.npmjs.org");
    expect(npmPackage.transport.type).toBe("stdio");
  });

  it("keeps all three version strings in lockstep", () => {
    // The registry rejects a server.json version that doesn't resolve to a
    // published npm version, so these must be bumped together.
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.packages[0].version).toBe(pkg.version);
  });

  it("stays inside the registry's 100-character description limit", () => {
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
    // Directory pages show the npm description; keep the two identical so
    // there's only one string to edit.
    expect(serverJson.description).toBe(pkg.description);
  });
});

describe("advertised tool count", () => {
  const toolCount = registeredToolNames().length;

  it("registers each tool name exactly once", () => {
    const names = registeredToolNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("matches the count in the package description", () => {
    expect(pkg.description).toContain(`${toolCount} tools`);
  });

  it("matches the count in the README heading and intro", () => {
    expect(readme).toContain(`## Tools (${toolCount})`);
    expect(readme).toContain(`${toolCount} tools`);
  });
});
