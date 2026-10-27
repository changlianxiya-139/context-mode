// D-M7-NG-1: the hook works in a non-git project dir. Before the fix resolveProject threw NO_GIT_DIR,
// handleHook returned the empty allow shape and the model saw the full Bash output. Same real
// Claude Code 2.1.303 Bash PostToolUse payload as tests/v2/hooks/replace-live-golden.test.mjs.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ENTRY = join(ROOT, "src", "entries", "hook.ts");
const GOLDEN = join(ROOT, "e2e", "fixtures", "claude-code", "2.1.303", "PostToolUse-Bash-large.json");
let root;
let work;

before(() => {
  root = mkdtempSync(join(tmpdir(), "cm-ng-hook-"));
  work = join(root, "plain", "dir");
  mkdirSync(work, { recursive: true });
});

after(() => rmSync(root, { recursive: true, force: true }));

test("D-M7-NG-1: PostToolUse Bash large output in a non-git cwd returns the Bash replace shape", () => {
  assert.equal(existsSync(join(work, ".git")), false);
  const payload = JSON.parse(readFileSync(GOLDEN, "utf8"));
  payload.cwd = work;
  payload.transcript_path = join(root, "transcript.jsonl");
  const full = payload.tool_response.stdout;
  const home = join(root, "home");
  mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: work };
  const r = spawnSync(process.execPath, [ENTRY, "--agent", "claude-code"], { input: JSON.stringify(payload), cwd: work, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(r.stdout.trim(), "", "empty stdout: no project, no replace");
  const hso = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(hso.hookEventName, "PostToolUse");
  const out = hso.updatedToolOutput;
  assert.equal(typeof out, "object");
  assert.deepEqual(Object.keys(out).sort(), ["interrupted", "stderr", "stdout"]);
  assert.equal(out.stderr, "");
  assert.equal(out.interrupted, false);
  assert.ok(Buffer.byteLength(out.stdout) * 10 < Buffer.byteLength(full), `replaced ${Buffer.byteLength(out.stdout)} bytes`);
  assert.ok(out.stdout.includes('source:"s'));
  assert.ok(out.stdout.includes("ctx_search("));
  // The output is indexed in this project's DB, under the config dir in HOME.
  const projects = readdirSync(join(home, ".context-mode", "projects"));
  assert.equal(projects.length, 1);
  assert.equal(existsSync(join(home, ".context-mode", "projects", projects[0], "context.db")), true);
});
