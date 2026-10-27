// Golden test for the main-agent Bash replace (D-M7-RL-1). The payload is a real PostToolUse stdin
// captured live from Claude Code 2.1.303 (`seq 1 2000`, 8892 bytes of stdout), with session, cwd and
// transcript paths made neutral. Claude Code 2.1.303 applies updatedToolOutput for Bash only when it
// has Bash's output shape {stdout, stderr, interrupted}; a plain string is ignored and the model sees
// the full output (live check in docs/v2/benchmarks.md, "Replace live root cause").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ENTRY = join(ROOT, "src", "entries", "hook.ts");
const GOLDEN = join(ROOT, "e2e", "fixtures", "claude-code", "2.1.303", "PostToolUse-Bash-large.json");
let root;
let repo;

before(() => {
  root = mkdtempSync(join(tmpdir(), "cm-replace-golden-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
});

after(() => rmSync(root, { recursive: true, force: true }));

test("D-M7-RL-1: real 2.1.303 Bash PostToolUse payload gives a Bash-shaped, much shorter updatedToolOutput", () => {
  const payload = JSON.parse(readFileSync(GOLDEN, "utf8"));
  payload.cwd = repo;
  payload.transcript_path = join(root, "transcript.jsonl");
  const full = payload.tool_response.stdout;
  assert.equal(Buffer.byteLength(full), 8892);
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, CLAUDE_PROJECT_DIR: repo };
  const r = spawnSync(process.execPath, [ENTRY, "--agent", "claude-code"], { input: JSON.stringify(payload), cwd: repo, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const hso = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(hso.hookEventName, "PostToolUse");
  const out = hso.updatedToolOutput;
  // Bash's output shape: Claude Code drops a string here and the model sees the full output.
  assert.equal(typeof out, "object");
  assert.deepEqual(Object.keys(out).sort(), ["interrupted", "stderr", "stdout"]);
  assert.equal(out.stderr, "");
  assert.equal(out.interrupted, false);
  assert.equal(typeof out.stdout, "string");
  // Far below the full output, and it names the indexed source so the model can search the rest.
  assert.ok(Buffer.byteLength(out.stdout) * 10 < Buffer.byteLength(full), `replaced ${Buffer.byteLength(out.stdout)} bytes`);
  assert.ok(out.stdout.includes('source:"s'));
  assert.ok(out.stdout.includes("ctx_search("));
});
