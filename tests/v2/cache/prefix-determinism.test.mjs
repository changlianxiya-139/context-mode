// tests/v2/cache/prefix-determinism.test.mjs
// ADR-0021 rules 1 and 2 (OPEN-ITEMS C5). A cache hit needs the same prefix bytes, so:
//  1. initialize and tools/list are byte-identical across 5 starts per agent, each start with a different
//     cwd, TZ, store (HOME), locale and extra env; the server never emits notifications/tools/list_changed.
//  2. Tool descriptions and instructions are the build-time literals (src/prompt/*.md bytes), and
//     build/check-prompt-static.mjs finds no dynamic token in them (gate layer ci-checks).
//  3. Pi and OpenCode system-prompt bytes are identical on every turn of one session.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_IDS } from "../../../src/core/contracts/agents.ts";
import { TOOL_ORDER } from "../../../src/core/contracts/constants.ts";
import { TOOLS } from "../../../src/core/tools/registry.ts";
import { INSTRUCTIONS } from "../../../src/entries/server.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVER = path.join(REPO, "src", "entries", "server.ts");
const LINT = path.join(REPO, "build", "check-prompt-static.mjs");
const STARTS = 5;
const QUIET_MS = 400; // after tools/list, any list_changed the server would send arrives in this window
const TZS = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Europe/Istanbul", "Pacific/Chatham"];
const LANGS = ["C", "en_US.UTF-8", "tr_TR.UTF-8", "ja_JP.UTF-8", "de_DE.UTF-8"];

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cm-prefix-")));
after(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) { // D-M3-F-9: a kept DB handle blocks the delete on Windows; cleanup is best-effort there
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
});

// Start i of agent a: its own HOME (store), cwd (git repo, plain dir or nested dir), TZ, locale and env.
function startEnv(agent, i) {
  const dir = path.join(root, agent, String(i));
  const home = path.join(dir, "home");
  const cwd = path.join(dir, i % 3 === 0 ? "repo" : i % 3 === 1 ? "plain" : path.join("repo", "a", "b"));
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (i % 3 !== 1) execFileSync("git", ["init", "-q", path.join(dir, "repo")]);
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, HOME: home, USERPROFILE: home, TZ: TZS[i], LANG: LANGS[i], LC_ALL: LANGS[i] };
  env["CM_PREFIX_PROBE_" + i] = String(Date.now() + i);
  if (i % 2 === 1) env.CLAUDE_PROJECT_DIR = cwd;
  if (i >= 2) env.CLAUDE_CODE_SESSION_ID = "sess-" + agent + "-" + i;
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return { cwd, env };
}

// One server start: initialize, initialized, tools/list. Returns the raw reply lines and every notification.
function probe(agent, i) {
  const { cwd, env } = startEnv(agent, i);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER, "--agent", agent], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    const replies = new Map();
    const notes = [];
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${agent}#${i}: no reply in 30 s; stderr: ${stderr}`)); }, 30_000);
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", reject);
    p.on("close", () => { clearTimeout(timer); resolve({ init: replies.get(1), list: replies.get(2), notes, stderr }); });
    p.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line === "") continue;
        const msg = JSON.parse(line);
        if (msg.id === undefined) { notes.push(msg.method); continue; }
        replies.set(msg.id, line);
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          setTimeout(() => p.stdin.end(), QUIET_MS);
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prefix-probe-" + i, version: String(i) } } });
  });
}

for (const agent of AGENT_IDS) {
  test(`prefix: ${agent} initialize and tools/list are byte-identical across ${STARTS} starts, no list_changed`, async () => {
    const runs = await Promise.all(Array.from({ length: STARTS }, (_, i) => probe(agent, i)));
    for (const [i, r] of runs.entries()) {
      assert.ok(r.init !== undefined, `${agent}#${i}: no initialize reply; stderr: ${r.stderr}`);
      assert.ok(r.list !== undefined, `${agent}#${i}: no tools/list reply; stderr: ${r.stderr}`);
      assert.deepEqual(r.notes.filter((m) => m === "notifications/tools/list_changed"), [], `${agent}#${i} sent list_changed`);
    }
    const init = JSON.parse(runs[0].init).result;
    assert.equal(init.instructions, INSTRUCTIONS);
    assert.deepEqual(JSON.parse(runs[0].list).result.tools.map((t) => t.name), [...TOOL_ORDER]);
    for (let i = 1; i < STARTS; i++) {
      assert.equal(runs[i].init, runs[0].init, `${agent}: initialize bytes of start ${i + 1} differ from start 1`);
      assert.equal(runs[i].list, runs[0].list, `${agent}: tools/list bytes of start ${i + 1} differ from start 1`);
    }
  });
}

test("prefix: instructions and every tool description are the src/prompt/*.md bytes, nothing added at run time", () => {
  assert.equal(INSTRUCTIONS, readFileSync(path.join(REPO, "src", "prompt", "instructions.md"), "utf8"));
  assert.deepEqual(TOOLS.map((t) => t.name), [...TOOL_ORDER]);
  for (const t of TOOLS) {
    assert.equal(t.description, readFileSync(path.join(REPO, "src", "prompt", "tools", t.name + ".md"), "utf8"), t.name);
  }
});

test("prefix lint: build/check-prompt-static.mjs passes on the repo prompt files", () => {
  const r = spawnSync(process.execPath, [LINT], { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.startsWith("PASS "), r.stdout);
});

test("prefix lint: each dynamic token in a tool description or the instructions fails the lint", () => {
  const cases = {
    "date": "Results since 2026-10-26 rank first.",
    "time": "Indexed at 14:02 today.",
    "template": "Searches ${project} content.",
    "brace placeholder": "Searches {cwd} content.",
    "home path": "Reads /Users/alice/notes.",
    "linux home": "Reads /home/alice/notes.",
    "tilde path": "Reads ~/notes.",
    "windows path": "Reads C:\\Users\\alice.",
    "uuid": "Session 280ff837-09ba-4152-bb02-89ec3a42eca9 only.",
  };
  for (const [name, text] of Object.entries(cases)) {
    for (const file of ["instructions.md", path.join("tools", "ctx_search.md")]) {
      const dir = path.join(root, "lint", name.replace(/ /g, "-"), file === "instructions.md" ? "i" : "t");
      mkdirSync(path.join(dir, "tools"), { recursive: true });
      writeFileSync(path.join(dir, "instructions.md"), "Static instructions.");
      for (const tool of TOOL_ORDER) writeFileSync(path.join(dir, "tools", tool + ".md"), "Static description.");
      writeFileSync(path.join(dir, file), text);
      const r = spawnSync(process.execPath, [LINT, "--prompt-dir", dir], { encoding: "utf8" });
      assert.equal(r.status, 1, `${name} in ${file}: ${r.stdout}${r.stderr}`);
      assert.ok(r.stdout.startsWith("FAIL "), `${name} in ${file}: ${r.stdout}`);
      assert.ok(r.stdout.includes(file), `${name}: the FAIL line names ${file}: ${r.stdout}`);
    }
  }
});

test("prefix: the gate's ci-checks layer runs build/check-prompt-static.mjs", () => {
  const gate = readFileSync(path.join(REPO, "scripts", "gate.mjs"), "utf8");
  assert.ok(gate.includes('["build/check-prompt-static.mjs"]'), "scripts/gate.mjs CI_CHECKS lists build/check-prompt-static.mjs");
  const ci = readFileSync(path.join(REPO, ".github", "workflows", "ci.yml"), "utf8");
  assert.ok(ci.includes("- run: node build/check-prompt-static.mjs"), "ci.yml runs the same check (D-M4-GS4-1)");
});

// Pi: same fake host as pi-cache.test.mjs (agent-session.js:777-797 keeps result.systemPrompt, else base).
test("prefix: pi system prompt bytes are identical on turns 1..6 of one session", async () => {
  const { default: piExtension } = await import("../../../src/entries/pi.ts");
  const repo = path.join(root, "pi-repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const oldHome = process.env.HOME;
  process.env.HOME = path.join(root, "pi-home"); process.env.USERPROFILE = path.join(root, "pi-home");
  try {
    const handlers = new Map();
    piExtension({ on: (name, fn) => handlers.set(name, fn), registerTool: () => {} });
    const ctx = { cwd: repo, sessionManager: { getSessionId: () => "prefix-pi" } };
    const seen = [];
    for (let i = 0; i < 6; i++) {
      await handlers.get("input")({ text: "prompt " + i }, ctx);
      const r = await handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "p" + i, systemPrompt: "BASE" }, ctx);
      seen.push(r?.systemPrompt ?? "BASE");
    }
    for (let i = 1; i < seen.length; i++) assert.equal(seen[i], seen[0], `pi turn ${i + 1} differs from turn 1`);
  } finally {
    process.env.HOME = oldHome;
  }
});

test("prefix: opencode system payload bytes are identical on turns 1..6 of one session", async () => {
  const opencodePlugin = await import("../../../src/entries/opencode.ts");
  const repo = path.join(root, "oc-repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  const oldHome = process.env.HOME;
  const oldProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.HOME = path.join(root, "oc-home"); process.env.USERPROFILE = path.join(root, "oc-home");
  delete process.env.CLAUDE_PROJECT_DIR;
  try {
    const hooks = await opencodePlugin.setup({ directory: repo, tool: () => {} });
    const seen = [];
    for (let i = 0; i < 6; i++) {
      await hooks["chat.message"]({ sessionID: "prefix-oc" }, { parts: [{ type: "text", text: "work " + i }] });
      await hooks["tool.execute.after"]({ sessionID: "prefix-oc", tool: "bash", callID: "c" + i, args: { command: "ls" } }, { output: "a b " + i });
      const out = { system: ["HOST SYSTEM"] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "prefix-oc" }, out);
      seen.push(JSON.stringify(out.system));
    }
    for (let i = 1; i < seen.length; i++) assert.equal(seen[i], seen[0], `opencode turn ${i + 1} differs from turn 1`);
  } finally {
    process.env.HOME = oldHome;
    if (oldProject !== undefined) process.env.CLAUDE_PROJECT_DIR = oldProject;
  }
});
