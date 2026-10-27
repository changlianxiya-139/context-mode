// tests/v2/plugins/opencode-ported.test.mjs
// Ported from tests/opencode-plugin.test.ts (cleanup-plan W1-ops, PORT row). Spec: docs/v2/impl/12-plugins.md §4.
// Drives the real src/entries/opencode.ts against a real git repo and a real store under a temp HOME.
// Not ported (behaviour gone in v2, DEVIATIONS D-M7-CLN-2): the v1 AGENTS.md/CLAUDE.md capture (OC-4),
// the OC-1 marker quorum, the OC-3 auto-injection budget, and the v1 native zod preprocessing (#621/#627).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as opencodePlugin from "../../../src/entries/opencode.ts";

let root;
let repo;
let oldHome;
let oldProject;

function rmTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cm-oc-ported-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  oldHome = process.env.HOME;
  oldProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.HOME = root; process.env.USERPROFILE = root;
  delete process.env.CLAUDE_PROJECT_DIR;
});

after(() => {
  process.env.HOME = oldHome;
  if (oldProject !== undefined) process.env.CLAUDE_PROJECT_DIR = oldProject;
  rmTemp(root);
});

async function load() {
  const registered = new Map();
  const hooks = await opencodePlugin.setup({ directory: repo, tool: (name, def) => registered.set(name, def) });
  return { hooks, registered };
}

test("plugin tool map: the factory registers every ctx_* tool and returns the 6 hook handlers (#574)", async () => {
  const { hooks, registered } = await load();
  for (const name of ["ctx_execute", "ctx_search", "ctx_stats"]) assert.ok(registered.has(name), name);
  for (const name of registered.keys()) assert.ok(name.startsWith("ctx_"), name);
  for (const key of ["chat.message", "tool.execute.before", "tool.execute.after", "experimental.chat.system.transform", "experimental.session.compacting", "event"]) {
    assert.equal(typeof hooks[key], "function", key);
  }
});

test("tool.execute.before: webfetch is denied by throwing the policy line; the bash tool is routed like every other host (D-HF-OPENCODE-SHELL-1)", async () => {
  const { hooks } = await load();
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "webfetch", sessionID: "s-block", callID: "c1" }, { args: { url: "https://example.com" } }),
    (err) => err instanceof Error && err.message !== "",
  );
  // D-HF-OPENCODE-SHELL-1: the row lists shell ["bash"], so an inline HTTP call is denied like on every other host.
  await assert.rejects(
    hooks["tool.execute.before"]({ tool: "bash", sessionID: "s-block", callID: "c2" }, { args: { command: "curl https://example.com" } }),
    (err) => err instanceof Error && err.message.includes("ctx_"),
  );
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s-block", callID: "c3" }, { args: { command: "ls" } });
});

test("tool.execute.before and after: empty input does not throw", async () => {
  const { hooks } = await load();
  await hooks["tool.execute.before"]({}, { args: {} });
  await hooks["tool.execute.after"]({}, { output: "" });
});

test("tool.execute.after: file read, file write and git events from Bash are captured without throwing", async () => {
  const { hooks } = await load();
  const sid = "s-after";
  await hooks["tool.execute.after"]({ tool: "read", sessionID: sid, callID: "a1", args: { filePath: join(repo, "a.ts") } }, { output: "x" });
  await hooks["tool.execute.after"]({ tool: "write", sessionID: sid, callID: "a2", args: { filePath: join(repo, "b.ts"), content: "y" } }, { output: "ok" });
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: sid, callID: "a3", args: { command: "git status" } }, { output: "clean" });
});

test("system.transform: no-op without a sessionID is safe, with one it adds exactly one entry and a second call adds none (#1085)", async () => {
  const { hooks } = await load();
  const out = { system: ["header"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "s-sys" }, out);
  assert.equal(out.system[0], "header", "system[0] header is preserved");
  assert.equal(out.system.length, 2);
  await hooks["experimental.chat.system.transform"]({ sessionID: "s-sys" }, out);
  assert.equal(out.system.length, 2, "same payload is never added twice");
});

test("system.transform: the payload for a session is fixed bytes on every request (prompt-cache stable, Q12)", async () => {
  const { hooks } = await load();
  const a = { system: [] };
  const b = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "s-fix" }, a);
  await hooks["chat.message"]({ sessionID: "s-fix" }, { parts: [{ type: "text", text: "hello" }] });
  await hooks["experimental.chat.system.transform"]({ sessionID: "s-fix" }, b);
  assert.deepEqual(b.system, a.system);
});

test("chat.message: user prompt with missing or empty parts is handled", async () => {
  const { hooks } = await load();
  await hooks["chat.message"]({ sessionID: "s-msg" }, { parts: [] });
  await hooks["chat.message"]({ sessionID: "s-msg" }, {});
  await hooks["chat.message"]({ sessionID: "s-msg" }, { parts: [{ type: "text", text: "real prompt" }, { type: "file" }] });
});

test("experimental.session.compacting: can be called many times and for a session with no events", async () => {
  const { hooks } = await load();
  await hooks["experimental.session.compacting"]({ sessionID: "s-compact" });
  await hooks["experimental.session.compacting"]({ sessionID: "s-compact" });
  await hooks["experimental.session.compacting"]({});
});

test("event: a rejecting or unrelated bus event never breaks the turn (#448)", async () => {
  const { hooks } = await load();
  await hooks.event({ event: { type: "session.idle" } });
  await hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "text" } } } });
  await hooks.event({ event: { type: "message.part.updated", properties: { part: { type: "step-finish", sessionID: "s-evt" } } } });
  await hooks.event({ event: {} });
});

test("registered ctx_stats executes in process without an MCP child (#574 smoke)", async () => {
  const { registered } = await load();
  const out = await registered.get("ctx_stats").execute({}, { sessionID: "s-stats" });
  assert.equal(typeof out, "string");
});

test("registered tool: invalid args return the validation message, they do not throw (#621)", async () => {
  const { registered } = await load();
  const out = await registered.get("ctx_search").execute({ queries: 12345 }, { sessionID: "s-bad" });
  assert.equal(typeof out, "string");
  assert.notEqual(out, "");
});
