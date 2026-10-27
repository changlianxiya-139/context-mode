// D-FU-PS-1 (owner decision 2026-10-21, ADR-0001: one fixed order per agent, no runtime fallback path).
// Claude Code project source order: CLAUDE_PROJECT_DIR, then the payload cwd (a documented common hook
// input field), then process.cwd(). Before the fix a Claude Code payload with cwd but no
// CLAUDE_PROJECT_DIR threw NO_PROJECT, and handleHook returned the empty allow shape with no log line.
// handleHook step 3 now writes one stderr line "hooks: no project: <code> <detail>" when it still throws.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProject } from "../../../src/core/project/resolve.ts";
import { handleHook } from "../../../src/core/hooks/dispatch.ts";
import { getAdapter } from "../../../src/adapters/table.ts";
import { AGENT_IDS } from "../../../src/core/contracts/agents.ts";
import { CtxError } from "../../../src/core/contracts/errors.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ENTRY = join(ROOT, "src", "entries", "hook.ts");
const GOLDEN = join(ROOT, "e2e", "fixtures", "claude-code", "2.1.303", "PostToolUse-Bash-large.json");
let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), "cm-ps-"));
});

after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));

function keyOf(dir) {
  return createHash("sha256").update(dir).digest("hex").slice(0, 16);
}

// Spawn the real hook entry with the real Claude Code 2.1.303 Bash PostToolUse payload, no CLAUDE_PROJECT_DIR.
function runHook(name, payloadCwd, spawnCwd) {
  const payload = JSON.parse(readFileSync(GOLDEN, "utf8"));
  if (payloadCwd === undefined) delete payload.cwd;
  else payload.cwd = payloadCwd;
  payload.transcript_path = join(root, name + "-transcript.jsonl");
  const home = join(root, name + "-home");
  mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
  const r = spawnSync(process.execPath, [ENTRY, "--agent", "claude-code"], { input: JSON.stringify(payload), cwd: spawnCwd, env, encoding: "utf8" });
  return { r, home, payload, full: payload.tool_response.stdout };
}

function assertReplaced({ r, home, payload, full }, projectDir) {
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(r.stdout.trim(), "", "empty stdout: no project, no replace. stderr: " + r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof out, "object");
  assert.ok(Buffer.byteLength(out.stdout) * 10 < Buffer.byteLength(full), `replaced ${Buffer.byteLength(out.stdout)} bytes`);
  assert.ok(out.stdout.includes('source:"s'));
  const projects = readdirSync(join(home, ".context-mode", "projects"));
  assert.deepEqual(projects, [keyOf(projectDir)]);
}

test("D-FU-PS-1: Claude Code payload cwd, no CLAUDE_PROJECT_DIR, non-git dir -> Bash replace keyed by realpath(cwd)", () => {
  const work = join(root, "plain");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(work);
  mkdirSync(elsewhere);
  assertReplaced(runHook("plain", work, elsewhere), realpathSync.native(work));
});

test("D-FU-PS-1: Claude Code payload cwd, no CLAUDE_PROJECT_DIR, git dir -> Bash replace keyed by the git common dir", () => {
  const repo = join(root, "repo");
  const elsewhere = join(root, "elsewhere-git");
  mkdirSync(repo);
  mkdirSync(elsewhere);
  execFileSync("git", ["init", "-q", repo]);
  const sub = join(repo, "sub");
  mkdirSync(sub);
  assertReplaced(runHook("git", sub, elsewhere), realpathSync.native(join(repo, ".git")));
});

test("D-FU-PS-1: Claude Code payload with no cwd and no CLAUDE_PROJECT_DIR -> the hook's process.cwd() is the project", () => {
  const work = join(root, "spawn-cwd");
  mkdirSync(work);
  assertReplaced(runHook("nocwd", undefined, work), realpathSync.native(work));
});

test("D-FU-PS-1: resolveProject claude-code order is CLAUDE_PROJECT_DIR, then cwd, then process.cwd()", () => {
  const a = join(root, "order-a");
  const b = join(root, "order-b");
  const c = join(root, "order-c");
  for (const d of [a, b, c]) mkdirSync(d);
  assert.equal(resolveProject("claude-code", { env: { CLAUDE_PROJECT_DIR: a }, argv: [], cwd: b }).worktree, realpathSync.native(a));
  assert.equal(resolveProject("claude-code", { env: {}, argv: [], cwd: b }).worktree, realpathSync.native(b));
  assert.equal(resolveProject("claude-code", { env: { CLAUDE_PROJECT_DIR: "" }, argv: [], cwd: b }).worktree, realpathSync.native(b));
  const old = process.cwd();
  process.chdir(c);
  try {
    const ctx = resolveProject("claude-code", { env: {}, argv: [], cwd: "" });
    assert.equal(ctx.worktree, realpathSync.native(c));
    assert.equal(ctx.source, "env:CLAUDE_PROJECT_DIR");
  } finally {
    process.chdir(old);
  }
});

function captureStderr() {
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (ch) => { lines.push(String(ch)); return true; };
  return { lines, restore: () => { process.stderr.write = orig; } };
}

test("D-FU-PS-1: a project dir that does not exist -> allow plus exactly one stderr line with NO_GIT_DIR", async () => {
  const gone = join(root, "does-not-exist");
  const payload = JSON.parse(readFileSync(GOLDEN, "utf8"));
  payload.cwd = gone;
  const cap = captureStderr();
  let out;
  try {
    out = await handleHook("claude-code", payload, { PATH: process.env.PATH, HOME: join(root, "gone-home"), USERPROFILE: join(root, "gone-home") });
  } finally {
    cap.restore();
  }
  assert.deepEqual(out, { stdout: "", exitCode: 0 });
  assert.equal(cap.lines.length, 1, JSON.stringify(cap.lines));
  assert.ok(cap.lines[0].startsWith("hooks: no project: NO_GIT_DIR "), cap.lines[0]);
  assert.ok(cap.lines[0].includes(gone), cap.lines[0]);
  assert.ok(cap.lines[0].endsWith("\n"));
});

test("D-FU-PS-1: an unknown agent id in handleHook -> empty output plus one stderr line (no silent drop)", async () => {
  const cap = captureStderr();
  let out;
  try {
    out = await handleHook("nope", {}, {});
  } finally {
    cap.restore();
  }
  assert.deepEqual(out, { stdout: "", exitCode: 0 });
  assert.equal(cap.lines.length, 1, JSON.stringify(cap.lines));
  assert.ok(cap.lines[0].startsWith("hooks: unknown agent "), cap.lines[0]);
});

test("D-FU-PS-1: every other agent keeps its one project source; Claude Code's env and cwd fallback are not theirs", () => {
  const own = join(root, "own");
  const foreign = join(root, "foreign");
  mkdirSync(own);
  mkdirSync(foreign);
  const expected = {
    codex: "arg:--agent+cwd", "copilot-cli": "arg:--agent+cwd", kiro: "arg:--agent+cwd",
    vscode: "arg:workspaceFolder", gemini: "spawn-cwd", qwen: "spawn-cwd", zcode: "spawn-cwd", opencode: "spawn-cwd",
    pi: "pi:ctx.cwd", "claude-code": "env:CLAUDE_PROJECT_DIR",
  };
  assert.deepEqual([...AGENT_IDS].sort(), Object.keys(expected).sort());
  for (const agent of AGENT_IDS) assert.equal(getAdapter(agent).projectSource, expected[agent], agent);
  const env = { CLAUDE_PROJECT_DIR: foreign };
  for (const agent of ["codex", "copilot-cli", "kiro", "gemini", "qwen", "zcode", "opencode"]) {
    const ctx = resolveProject(agent, { env, argv: ["--agent", agent], cwd: own });
    assert.equal(ctx.worktree, realpathSync.native(own), agent);
    assert.equal(ctx.source, expected[agent], agent);
    // An empty spawn cwd is still NO_PROJECT for them: no process.cwd() fallback.
    assert.throws(() => resolveProject(agent, { env, argv: ["--agent", agent], cwd: "" }), (e) => e instanceof CtxError && e.code === "NO_PROJECT", agent);
  }
  const vs = resolveProject("vscode", { env, argv: ["--workspace-folder", own], cwd: foreign });
  assert.equal(vs.worktree, realpathSync.native(own));
  assert.throws(() => resolveProject("vscode", { env, argv: [], cwd: own }), (e) => e instanceof CtxError && e.code === "NO_PROJECT");
  const pi = resolveProject("pi", { env, argv: [], cwd: foreign, piCwd: own });
  assert.equal(pi.worktree, realpathSync.native(own));
  assert.throws(() => resolveProject("pi", { env, argv: [], cwd: own }), (e) => e instanceof CtxError && e.code === "NO_PROJECT");
});
