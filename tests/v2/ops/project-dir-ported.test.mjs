// tests/v2/ops/project-dir-ported.test.mjs
// Ported from tests/util/{project-dir,project-dir-matrix,codex-session-cwd-resolution}.test.ts (cleanup-plan W1-ops,
// PORT rows). v1 walked a fallback chain (env vars, PWD, transcript and Codex session logs, plugin-path filter).
// v2 has ONE named source per host and no fallback (impl/02 §2, ADR-0007 decision 4, DEVIATIONS D-M1-5), so the
// invariants below are the v2 form: own source wins, foreign host vars are never read (#545 MUST-3, #561),
// session logs are never read (Codex session cwd), a missing source is an error and never a guess.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProject } from "../../../src/core/project/resolve.ts";
import { CtxError } from "../../../src/core/contracts/errors.ts";
import { AGENT_IDS } from "../../../src/core/contracts/agents.ts";

let root;
let repo;
let other;
let oldHome;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cm-projdir-")));
  oldHome = process.env.HOME;
  process.env.HOME = root; process.env.USERPROFILE = root;
  repo = join(root, "repo");
  other = join(root, "other");
  for (const d of [repo, other]) {
    mkdirSync(d);
    execFileSync("git", ["init", "-q", d]);
  }
});

after(() => {
  process.env.HOME = oldHome;
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
});

const FOREIGN_ENV = [
  "CLAUDE_PROJECT_DIR", "GEMINI_PROJECT_DIR", "QWEN_PROJECT_DIR", "VSCODE_CWD", "OPENCODE_PROJECT_DIR",
  "PI_PROJECT_DIR", "PI_WORKSPACE_DIR", "CURSOR_CWD", "IDEA_INITIAL_DIRECTORY", "CONTEXT_MODE_PROJECT_DIR", "PWD",
];

// The input that carries each host's own project (impl/02 §2, PRD §5 host table).
function ownInput(agent, dir, env = {}) {
  switch (agent) {
    case "claude-code": return { env: { ...env, CLAUDE_PROJECT_DIR: dir }, argv: [], cwd: other };
    case "vscode": return { env, argv: ["--workspace-folder", dir], cwd: other };
    case "pi": return { env, argv: [], cwd: other, piCwd: dir };
    default: return { env, argv: ["--agent", agent], cwd: dir };
  }
}

test("matrix: every host resolves its own source and the key is the same for all hosts of one repo (#545 MUST-3)", () => {
  const keys = new Set();
  for (const agent of AGENT_IDS) {
    const ctx = resolveProject(agent, ownInput(agent, repo));
    assert.equal(ctx.worktree, realpathSync.native(repo), agent);
    assert.equal(ctx.agent, agent);
    keys.add(ctx.projectKey);
  }
  assert.equal(keys.size, 1, "one repo, one projectKey, whichever host asks");
});

test("matrix: no host reads a foreign workspace or identification variable, even when it points at another repo (#545, #561)", () => {
  const foreign = Object.fromEntries(FOREIGN_ENV.map((k) => [k, other]));
  for (const agent of AGENT_IDS) {
    const env = { ...foreign };
    if (agent === "claude-code") delete env.CLAUDE_PROJECT_DIR; // its own source is set by ownInput
    const ctx = resolveProject(agent, ownInput(agent, repo, env));
    assert.equal(ctx.worktree, realpathSync.native(repo), `${agent} followed a foreign variable`);
  }
});

test("matrix: a host whose own source is empty fails with NO_PROJECT and the source kind, whatever foreign variables exist", () => {
  const foreign = Object.fromEntries(FOREIGN_ENV.map((k) => [k, repo]));
  const cases = {
    vscode: { env: foreign, argv: [], cwd: other },
    pi: { env: foreign, argv: [], cwd: other },
  };
  for (const [agent, input] of Object.entries(cases)) {
    assert.throws(() => resolveProject(agent, input), (e) => e instanceof CtxError && e.code === "NO_PROJECT", agent);
  }
  // D-FU-PS-1: Claude Code's fixed order is CLAUDE_PROJECT_DIR, then the payload cwd, then process.cwd();
  // an empty CLAUDE_PROJECT_DIR goes to the cwd, never to a foreign variable.
  const cc = resolveProject("claude-code", { env: { ...foreign, CLAUDE_PROJECT_DIR: "" }, argv: [], cwd: other });
  assert.equal(cc.worktree, realpathSync.native(other));
});

test("codex: the project is the spawn cwd; a Codex session log naming another cwd is never read (session-cwd resolution gone)", () => {
  const codexHome = join(root, ".codex", "sessions", "2026", "10", "21");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "rollout-1.jsonl"), JSON.stringify({ type: "session_meta", payload: { cwd: other } }) + "\n");
  const ctx = resolveProject("codex", { env: { CODEX_HOME: join(root, ".codex"), CLAUDE_PROJECT_DIR: other }, argv: ["--agent", "codex"], cwd: repo });
  assert.equal(ctx.worktree, realpathSync.native(repo));
});

test("a plugin install path as the cwd is not guessed around: with no git repo there it is its own project (D-M7-NG-1), never a fallback to PWD or CLAUDE_PROJECT_DIR", () => {
  const poisoned = join(root, ".claude", "plugins", "cache", "context-mode");
  mkdirSync(poisoned, { recursive: true });
  const ctx = resolveProject("codex", { env: { PWD: repo, CLAUDE_PROJECT_DIR: repo }, argv: ["--agent", "codex"], cwd: poisoned });
  assert.equal(ctx.worktree, realpathSync.native(poisoned));
  assert.notEqual(ctx.worktree, realpathSync.native(repo));
  assert.notEqual(ctx.projectKey, resolveProject("codex", { env: {}, argv: [], cwd: repo }).projectKey);
});

test("a cwd below the repo root resolves to the repo; the Claude transcript dir is never consulted", () => {
  const sub = join(repo, "a", "b");
  mkdirSync(sub, { recursive: true });
  const t = join(root, ".claude", "projects", "x");
  mkdirSync(t, { recursive: true });
  writeFileSync(join(t, "s.jsonl"), JSON.stringify({ cwd: other }) + "\n");
  const ctx = resolveProject("gemini", { env: {}, argv: [], cwd: sub });
  assert.equal(ctx.worktree, realpathSync.native(repo));
});

test("same repo from different cwd shapes gives one key; two repos give two keys", () => {
  const a = resolveProject("codex", { env: {}, argv: [], cwd: repo });
  const b = resolveProject("gemini", { env: {}, argv: [], cwd: join(repo, "a") });
  const c = resolveProject("codex", { env: {}, argv: [], cwd: other });
  assert.equal(a.projectKey, b.projectKey);
  assert.notEqual(a.projectKey, c.projectKey);
});

test("the Windows-style plugin path is a plain directory name to v2: it gets no special-case branch", () => {
  assert.throws(
    () => resolveProject("codex", { env: {}, argv: [], cwd: "C:\\Users\\x\\.claude\\plugins\\cache\\context-mode" }),
    (e) => e instanceof CtxError && e.code === "NO_GIT_DIR",
  );
});

test("compiled-ESM guard (v1 'resolver runs under Node without CommonJS require'): resolve.ts loads and runs as ESM under Node", () => {
  const out = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { resolveProject } from ${JSON.stringify(new URL("../../../src/core/project/resolve.ts", import.meta.url).href)};` +
    `console.log(resolveProject("codex", { env: {}, argv: [], cwd: ${JSON.stringify(repo)} }).projectKey);`], { encoding: "utf8", env: { ...process.env, HOME: root, USERPROFILE: root } });
  assert.match(out.trim(), /^[0-9a-f]{16}$/);
});
