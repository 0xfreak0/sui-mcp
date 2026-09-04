#!/usr/bin/env node
/**
 * Install the published package from npm into a throwaway directory and drive it
 * over stdio the way an MCP client would.
 *
 * This is the only check that exercises what users actually get. The tests in
 * test/packaging.test.ts run against the working tree; they can't catch a
 * tarball that installs but won't start — a missing `dist/` (the `files`
 * allowlist), a lost executable bit, or a runtime-only import that never made
 * it into the build.
 *
 *   node scripts/verify-published.mjs           # latest on npm
 *   node scripts/verify-published.mjs 1.1.0     # a specific version
 */
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkgName = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name;
const wanted = process.argv[2];
const spec = wanted ? `${pkgName}@${wanted}` : `${pkgName}@latest`;

const dir = mkdtempSync(join(tmpdir(), "sui-mcp-verify-"));
let failed = false;

try {
  console.log(`Installing ${spec} into ${dir} ...`);
  execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore" });
  await installWithRetry(spec, dir);

  const installed = JSON.parse(
    readFileSync(join(dir, "node_modules", pkgName, "package.json"), "utf8"),
  );
  console.log(`\nInstalled ${pkgName}@${installed.version}`);
  console.log(`mcpName: ${installed.mcpName}`);

  await handshake(join(dir, "node_modules", ".bin", pkgName));
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  failed = true;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);

/**
 * Install, retrying while npm still reports the version as missing.
 *
 * This runs seconds after `npm publish` in CI, and the registry does not index
 * a new version instantly — 1.10.0 published successfully and then failed here
 * with ETARGET one second later, which marked a good release as failed and
 * skipped the GitHub release job behind it.
 *
 * Only ETARGET/E404 is retried, since that is the propagation case. Anything
 * else is a real failure and should surface immediately rather than being
 * waited out.
 */
async function installWithRetry(spec, dir, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try {
      execFileSync("npm", ["install", spec], { cwd: dir, stdio: "inherit" });
      return;
    } catch (err) {
      const out = `${err.stdout ?? ""}${err.stderr ?? ""}${err.message ?? ""}`;
      const propagating = /ETARGET|E404|No matching version/i.test(out);
      if (!propagating || i === attempts) throw err;
      const waitMs = i * 5000;
      console.log(`  not on the registry yet (attempt ${i}/${attempts}); retrying in ${waitMs / 1000}s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

/** initialize + tools/list against the installed bin. Rejects on timeout. */
function handshake(bin) {
  return new Promise((resolve, reject) => {
    // Spawned without a shell and with no shebang assist — if the executable bit
    // didn't survive packing, this is where it surfaces.
    const proc = spawn(bin, { stdio: ["pipe", "pipe", "inherit"] });
    const send = (m) => proc.stdin.write(JSON.stringify(m) + "\n");
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error("server did not respond within 30s"));
    }, 30_000);

    let buf = "";
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not exec ${bin}: ${err.message}`));
    });

    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;

        const msg = JSON.parse(line);
        if (msg.id === 1) {
          const info = msg.result.serverInfo;
          console.log(`\nHandshake OK — serverInfo: ${info.name} ${info.version}`);
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          const tools = msg.result.tools;
          clearTimeout(timer);
          proc.kill();
          console.log(`Tools listed: ${tools.length}`);
          if (tools.length === 0) return reject(new Error("server registered no tools"));
          console.log("\nPublished package is installable and starts correctly.");
          resolve();
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "verify-published", version: "0" },
      },
    });
  });
}
