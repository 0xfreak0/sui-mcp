import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const checker = join(root, ".githooks/identity-check.sh");

function check(args: string[], input = "", env: Record<string, string> = {}) {
  const result = spawnSync("bash", [checker, ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  expect(result.error).toBeUndefined();
  return result;
}

const accepts = (identity: string) => expect(check(["--identity", identity]).status).toBe(0);
const rejects = (identity: string) => expect(check(["--identity", identity]).status).toBe(1);

describe("commit identity guard", () => {
  it("accepts the account's actual noreply ID, known bots and permitted noreply domains", () => {
    accepts("Maintainer <25494238+0xfreak0@users.noreply.github.com>");
    accepts("Dependabot <49699333+dependabot[bot]@users.noreply.github.com>");
    accepts("Actions <41898282+github-actions[bot]@users.noreply.github.com>");
    accepts("GitHub <noreply@github.com>");
    accepts("Claude <noreply@anthropic.com>");
    accepts("Someone <someone@example.com>");
  });

  it("rejects misleading IDs, bare noreply, machine addresses and malformed identities", () => {
    rejects("Maintainer <4517098+0xfreak0@users.noreply.github.com>");
    rejects("Maintainer <noreply@users.noreply.github.com>");
    rejects("Bot <12+dependabot[bot]@users.noreply.github.com>");
    rejects("Someone <someone@host.internal>");
    rejects("Someone <someone@localhost.localdomain>");
    rejects("Someone <someone@build.home.arpa>");
    rejects("Someone <someone@192.168.1.5>");
    rejects("Someone <someone@buildbox>");
    rejects("Someone <someone@users.noreply.github.com>");
    rejects("someone@example.com");
  });

  it("checks both current git identities and every co-author trailer", () => {
    const good = {
      GIT_AUTHOR_NAME: "Maintainer",
      GIT_AUTHOR_EMAIL: "25494238+0xfreak0@users.noreply.github.com",
      GIT_COMMITTER_NAME: "GitHub",
      GIT_COMMITTER_EMAIL: "noreply@github.com",
    };
    expect(check(["--current"], "", good).status).toBe(0);
    expect(check(["--current"], "", { ...good, GIT_COMMITTER_EMAIL: "noreply@users.noreply.github.com" }).status).toBe(1);
    expect(check(["--current"], "", { ...good, GIT_AUTHOR_EMAIL: "4517098+0xfreak0@users.noreply.github.com" }).status).toBe(1);

    expect(check(["--message"], "Subject\n\nCo-authored-by: Claude Opus 5 <noreply@anthropic.com>\nco-authored-by: Someone <someone@example.com>\n").status).toBe(0);
    expect(check(["--message"], "Co-authored-by: Claude <noreply@anthropic.com>\nCo-authored-by: Maintainer <4517098+0xfreak0@users.noreply.github.com>\n").status).toBe(1);
    expect(check(["--message"], "Co-authored-by: nobody\n").status).toBe(1);
  });

  it("applies private patterns to author and committer emails without showing the pattern", () => {
    const temp = mkdtempSync(join(tmpdir(), "identity-patterns-"));
    try {
      copyFileSync(checker, join(temp, "identity-check.sh"));
      copyFileSync(join(root, ".githooks/leak-scan.sh"), join(temp, "leak-scan.sh"));
      copyFileSync(join(root, ".githooks/known-github-ids"), join(temp, "known-github-ids"));
      writeFileSync(join(temp, "patterns"), "");
      writeFileSync(join(temp, "patterns.local"), "someone@example\\.com\n");
      const result = spawnSync("bash", [join(temp, "identity-check.sh"), "--identity", "Someone <someone@example.com>"], {
        cwd: root, encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("matches a private pattern");
      expect(result.stderr).not.toContain("someone@example");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("verifies unfamiliar GitHub logins via the API in CI", () => {
    const temp = mkdtempSync(join(tmpdir(), "identity-check-"));
    try {
      writeFileSync(join(temp, "curl"), "#!/bin/sh\ncase \"$*\" in *https://api.github.com/users/unknown-login*) printf '{\"id\":12345}\\n' ;; *) exit 1 ;; esac\n", { mode: 0o755 });
      const env = { GITHUB_TOKEN: "test-token", PATH: `${temp}:${process.env.PATH}` };
      expect(check(["--identity", "Contributor <12345+unknown-login@users.noreply.github.com>"], "", env).status).toBe(0);
      expect(check(["--identity", "Contributor <12345+unknown-login@users.noreply.github.com>", "--ci"], "", env).status).toBe(0);
      expect(check(["--identity", "Contributor <4517098+unknown-login@users.noreply.github.com>", "--ci"], "", env).status).toBe(1);
      expect(check(["--identity", "Contributor <12345+unknown-login@users.noreply.github.com>", "--ci"], "", { ...env, GITHUB_TOKEN: "" }).status).toBe(1);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
