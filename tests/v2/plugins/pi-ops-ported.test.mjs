// tests/v2/plugins/pi-ported.test.mjs
// Ported from tests/pi-extension.test.ts (cleanup-plan W1-ops, PORT row). Spec: docs/v2/impl/12-plugins.md §3.
// Drives the real src/entries/pi.ts with a fake Pi API over a real git repo and a real store under a temp HOME.
// Not ported (gone in v2, DEVIATIONS D-M7-CLN-2): the v1 MCP stdio bridge (#426, #472, MCPStdioClient), the
// v1 SessionDB path resolvers (#473, #645), /ctx-stats as a Pi command, active_memory and role injection.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piExtension from "../../../src/entries/pi.ts";
import { INSTRUCTIONS } from "../../../src/entries/server.ts";

let root;
let repo;
let oldHome;

function rmTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
}

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cm-pi-ported-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  oldHome = process.env.HOME;
  process.env.HOME = root; process.env.USERPROFILE = root;
});

after(() => {
  process.env.HOME = oldHome;
  rmTemp(root);
});

function fakePi(opts = {}) {
  const handlers = new Map();
  const tools = new Map();
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerTool: (t) => {
      if (opts.failRegister && opts.failRegister.n-- > 0) throw new Error("registerTool failed");
      tools.set(t.name, t);
    },
  };
  return { pi, handlers, tools };
}
const ctxFor = (sid, cwd = repo) => ({ cwd, sessionManager: { getSessionId: () => sid } });

test("registration: the five event handlers register, registering twice and registering with no events throws nothing", () => {
  const a = fakePi();
  piExtension(a.pi);
  for (const name of ["before_agent_start", "input", "tool_call", "tool_result", "session_compact"]) {
    assert.equal(typeof a.handlers.get(name), "function", name);
  }
  const b = fakePi();
  assert.doesNotThrow(() => { piExtension(b.pi); piExtension(b.pi); });
});

test("before_agent_start: every ctx_* tool registers through pi.registerTool and a system prompt is returned (#426 regression guard)", async () => {
  const { pi, handlers, tools } = fakePi();
  piExtension(pi);
  const out = await handlers.get("before_agent_start")({ systemPrompt: "base" }, ctxFor("s1"));
  assert.ok(tools.size > 0);
  for (const name of tools.keys()) assert.ok(name.startsWith("ctx_"), name);
  assert.ok(tools.has("ctx_execute") && tools.has("ctx_stats"));
  assert.equal(typeof out.systemPrompt, "string");
  assert.ok(out.systemPrompt.startsWith("base"), "the host prompt stays first");
});

// D-CACHE-PI-1 replaces A24's "a second turn returns nothing": Pi 0.73.1 resets the system prompt to base on
// a turn without systemPrompt (agent-session.js:791-797), so "nothing" dropped INSTRUCTIONS on turn 2 and
// broke the cache. Pi replaces, never appends, so the prompt the model sees must hold INSTRUCTIONS exactly once
// and be the same bytes on every turn.
test("before_agent_start: instructions appear exactly once in the system prompt, the same bytes on a second turn (D-CACHE-PI-1)", async () => {
  const { pi, handlers } = fakePi();
  piExtension(pi);
  const first = await handlers.get("before_agent_start")({ systemPrompt: "" }, ctxFor("s2"));
  const second = await handlers.get("before_agent_start")({ systemPrompt: "" }, ctxFor("s2"));
  assert.ok(first.systemPrompt.length > 0);
  assert.equal(first.systemPrompt.split(INSTRUCTIONS).length - 1, 1, "INSTRUCTIONS exactly once on turn 1");
  assert.equal(second.systemPrompt, first.systemPrompt, "turn 2 system prompt is byte-identical to turn 1");
  assert.equal(second.systemPrompt.split(INSTRUCTIONS).length - 1, 1, "INSTRUCTIONS exactly once on turn 2");
});

test("before_agent_start: a registerTool failure is retried on the next turn (#1098)", async () => {
  const { pi, handlers, tools } = fakePi({ failRegister: { n: 1 } });
  piExtension(pi);
  await handlers.get("before_agent_start")({ systemPrompt: "" }, ctxFor("s3"));
  assert.equal(tools.size, 0);
  await handlers.get("before_agent_start")({ systemPrompt: "" }, ctxFor("s3"));
  assert.ok(tools.size > 0, "the next before_agent_start registers again");
});

test("tool_call: an ordinary bash command and a read are allowed (undefined, no block)", async () => {
  const { pi, handlers } = fakePi();
  piExtension(pi);
  await handlers.get("before_agent_start")({ systemPrompt: "" }, ctxFor("s4"));
  assert.equal(await handlers.get("tool_call")({ toolName: "bash", toolCallId: "t1", input: { command: "git status" } }, ctxFor("s4")), undefined);
  assert.equal(await handlers.get("tool_call")({ toolName: "read", toolCallId: "t2", input: { path: join(repo, "a.ts") } }, ctxFor("s4")), undefined);
});

test("tool_call and tool_result: a missing tool name and an empty event do not throw", async () => {
  const { pi, handlers } = fakePi();
  piExtension(pi);
  await handlers.get("before_agent_start")({ systemPrompt: "" }, ctxFor("s5"));
  await handlers.get("tool_call")({}, ctxFor("s5"));
  await handlers.get("tool_result")({}, ctxFor("s5"));
  await handlers.get("tool_result")({ toolName: "bash", toolCallId: "t3", input: { command: "ls" }, content: [{ type: "text", text: "a b" }], isError: true }, ctxFor("s5"));
});

test("tool_result: a small result is journaled and nothing is replaced", async () => {
  const { pi, handlers } = fakePi();
  piExtension(pi);
  await handlers.get("before_agent_start")({ systemPrompt: "" }, ctxFor("s6"));
  const out = await handlers.get("tool_result")({ toolName: "bash", toolCallId: "t4", input: { command: "echo hi" }, content: [{ type: "text", text: "hi" }], isError: false }, ctxFor("s6"));
  assert.equal(out, undefined);
});

test("session lifecycle: input, session_compact, then the next before_agent_start runs in order without error", async () => {
  const { pi, handlers } = fakePi();
  piExtension(pi);
  await handlers.get("before_agent_start")({ systemPrompt: "" }, ctxFor("s7"));
  assert.equal(await handlers.get("input")({ text: "a user prompt" }, ctxFor("s7")), undefined);
  assert.equal(await handlers.get("session_compact")({}, ctxFor("s7")), undefined);
  const out = await handlers.get("before_agent_start")({ systemPrompt: "base" }, ctxFor("s7"));
  assert.ok(out && typeof out === "object");
});

test("registered ctx_stats runs in process, invalid args throw the plain-text line and never a fence (#1094)", async () => {
  const { pi, handlers, tools } = fakePi();
  piExtension(pi);
  await handlers.get("before_agent_start")({ systemPrompt: "" }, ctxFor("s8"));
  const ok = await tools.get("ctx_stats").execute("c1", {});
  assert.equal(ok.content[0].type, "text");
  await assert.rejects(tools.get("ctx_search").execute("c2", { queries: 12345 }), (err) => err instanceof Error && !err.message.startsWith("```"));
});

test("per-instance state: two extension instances keep separate sessions and leave no module state (#983)", async () => {
  const a = fakePi();
  const b = fakePi();
  piExtension(a.pi);
  piExtension(b.pi);
  await a.handlers.get("before_agent_start")({ systemPrompt: "" }, ctxFor("sa"));
  const out = await b.handlers.get("before_agent_start")({ systemPrompt: "" }, ctxFor("sb"));
  assert.ok(out.systemPrompt.length > 0, "instance b delivers its own instructions");
});
