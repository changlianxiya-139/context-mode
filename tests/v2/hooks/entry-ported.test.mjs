// PORT of tests/hooks/run-hook.test.ts (#414, #453) to the v2 hook entry (cleanup-plan W1-hooks).
// v1 wrapped each hook script and logged a throw to <configDir>/context-mode/hook-errors.log, then exited 0.
// v2 has no wrapper and no log file (impl/09 §5.2): every failure is empty stdout, exit 0, one stderr line.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRY = join(import.meta.dirname, "..", "..", "..", "src", "entries", "hook.ts");
let root, repo, cfg;
before(() => {
  root = mkdtempSync(join(tmpdir(), "cm-hook-ported-"));
  repo = join(root, "repo");
  cfg = join(root, "cfg");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
});
after(() => rmSync(root, { recursive: true, force: true }));
const run = (input, env = {}) => spawnSync(process.execPath, [ENTRY, "--agent", "claude-code"],
  { input, cwd: repo, encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, CLAUDE_PROJECT_DIR: repo, ...env } });

test("run-hook #414: empty stdin never crashes the host: exit 0, empty stdout, one stderr line", () => {
  const r = run("");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.trim().split("\n").length, 1);
});

test("run-hook #414: a payload with an unknown event still exits 0 with empty stdout", () => {
  const r = run(JSON.stringify({ hook_event_name: "NoSuchEvent", session_id: "s" }));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("run-hook #453: a failure writes nothing under CLAUDE_CONFIG_DIR (no hook-errors.log in v2); stderr is the only trace", () => {
  const r = run("{{", { CLAUDE_CONFIG_DIR: cfg });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.ok(r.stderr.startsWith("hooks:"));
  assert.ok(!existsSync(cfg), "CLAUDE_CONFIG_DIR must not be created by a failing hook");
});
