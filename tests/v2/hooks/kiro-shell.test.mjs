// tests/v2/hooks/kiro-shell.test.mjs
// D-HF-KIRO-SHELL-1. Kiro CLI V3 docs (kiro.dev/docs/cli/v3/hooks-migration/, updated 2026-10-10): matcher "shell"
// selects the execute_bash tool, whose hook input is tool_name "execute_bash". Kiro CLI 2.x reference
// (kiro.dev/docs/cli/2x-reference/): exit code 2 on preToolUse blocks the tool and STDERR is returned to the agent.
// Kiro PostToolUse cannot replace output, so saving is PreToolUse deny + redirect to ctx_execute, text on stderr.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleHook } from "../../../src/core/hooks/dispatch.ts";
import { encode } from "../../../src/adapters/kiro.ts";
import { getAdapter } from "../../../src/adapters/table.ts";
import { generateManifests } from "../../../build/manifests.ts";

const REPO = path.resolve(import.meta.dirname, "../../..");
let root, repo, oldHome;
before(() => {
  root = mkdtempSync(path.join(tmpdir(), "cm-kiro-shell-"));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, "big.log"), "x".repeat(200_000));
  oldHome = process.env.HOME;
  process.env.HOME = root;
});
after(() => { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

test("kiro: execute_bash, execute_pwsh and shell are the native shell tools (D-N7-KIRO-1)", () => {
  assert.deepEqual(getAdapter("kiro").nativeTools.shell, ["execute_bash", "execute_pwsh", "shell"]);
});

test("kiro: the hook file registers PreToolUse and PostToolUse for @mcp and for shell", () => {
  const dir = path.join(root, "pkg");
  mkdirSync(dir, { recursive: true });
  generateManifests(dir);
  const k = JSON.parse(readFileSync(path.join(dir, "hooks", "kiro.json"), "utf8"));
  for (const trig of ["PreToolUse", "PostToolUse"]) {
    const m = k.hooks.filter((h) => h.trigger === trig).map((h) => h.matcher).sort();
    assert.deepEqual(m, ["@mcp", "shell"], trig);
  }
});

test("kiro: encode deny exits 2 with the reason on stderr and empty stdout", () => {
  const ev = { event: "PreToolUse", agent: "kiro", sessionId: "k", cwd: "/p" };
  assert.deepEqual(encode(ev, { kind: "deny", reason: "why" }), { stdout: "", stderr: "why", exitCode: 2 });
});

test("kiro: a native shell cat of a large file is denied with exit 2 and a ctx_execute redirect", async () => {
  const out = await handleHook("kiro", {
    hook_event_name: "PreToolUse", session_id: "s-kiro", cwd: repo,
    tool_name: "execute_bash", tool_input: { command: "cat big.log" },
  }, { HOME: root, PATH: process.env.PATH });
  assert.equal(out.exitCode, 2);
  assert.equal(out.stdout, "");
  assert.ok(out.stderr.includes("ctx_execute"), out.stderr);
});

test("kiro: the hook process writes the deny text to stderr and exits 2", () => {
  const r = spawnSync(process.execPath, [path.join(REPO, "src/entries/hook.ts"), "--agent", "kiro"], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s-kiro2", cwd: repo, tool_name: "execute_bash", tool_input: { command: "cat big.log" } }),
    env: { HOME: root, PATH: process.env.PATH }, encoding: "utf8",
  });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  assert.ok(r.stderr.includes("ctx_execute"), r.stderr);
});
