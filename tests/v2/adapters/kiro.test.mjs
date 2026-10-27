// Unit tests for src/adapters/kiro.ts (impl/10 §8, impl/09 §5.2 item 6 + A28; DECISIONS-r3 Q24).
// Unit tests may import src/ (TECH-SPEC §6.2a); e2e/ never does (GS4).
// Payloads follow the Kiro CLI V3 hook shape (tickets/spike-hooks-verified.md §2): hook_event_name,
// session_id, cwd on every hook; tool_input on tool hooks; the prompt comes from env USER_PROMPT.
import { test } from "node:test";
import assert from "node:assert/strict";

import { decode, encode, TOOL_NAME_PREFIX } from "../../../src/adapters/kiro.ts";

const base = { session_id: "k-1", cwd: "/tmp/proj" };

function withPrompt(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "USER_PROMPT");
  const old = process.env.USER_PROMPT;
  if (value === undefined) delete process.env.USER_PROMPT;
  else process.env.USER_PROMPT = value;
  try {
    return fn();
  } finally {
    if (had) process.env.USER_PROMPT = old;
    else delete process.env.USER_PROMPT;
  }
}

test("own prefix is mcp_context-mode_ (impl/10 §1.3, A1)", () => {
  assert.equal(TOOL_NAME_PREFIX, "mcp_context-mode_");
});

test("decode SessionStart and legacy agentSpawn; source read only when present", () => {
  assert.deepEqual(decode({ ...base, hook_event_name: "SessionStart" }), { event: "SessionStart", agent: "kiro", sessionId: "k-1", cwd: "/tmp/proj" });
  assert.deepEqual(decode({ ...base, hook_event_name: "agentSpawn" }), { event: "SessionStart", agent: "kiro", sessionId: "k-1", cwd: "/tmp/proj" });
  for (const source of ["startup", "resume", "clear", "compact"]) {
    assert.equal(decode({ ...base, hook_event_name: "SessionStart", source }).source, source);
  }
  assert.equal("source" in decode({ ...base, hook_event_name: "SessionStart", source: "other" }), false);
});

test("decode PromptSubmit and legacy userPromptSubmit read the prompt from env USER_PROMPT only", () => {
  withPrompt("run tests", () => {
    const ev = decode({ ...base, hook_event_name: "PromptSubmit", prompt: "stdin field is ignored" });
    assert.deepEqual(ev, { event: "UserPromptSubmit", agent: "kiro", sessionId: "k-1", cwd: "/tmp/proj", prompt: "run tests" });
    assert.equal(decode({ ...base, hook_event_name: "userPromptSubmit" }).event, "UserPromptSubmit");
  });
  withPrompt(undefined, () => {
    const ev = decode({ ...base, hook_event_name: "PromptSubmit", prompt: "stdin field is ignored" });
    assert.equal("prompt" in ev, false);
  });
});

test("decode PreToolUse: own prefix to bare ctx_*, other mcp server to mcp:<server>:<tool>, native unchanged", () => {
  const own = decode({ ...base, hook_event_name: "PreToolUse", tool_name: "mcp_context-mode_ctx_execute", tool_input: { language: "shell", code: "ls" } });
  assert.deepEqual(own.tool, { name: "mcp_context-mode_ctx_execute", canonicalName: "ctx_execute", input: { language: "shell", code: "ls" } });
  const other = decode({ ...base, hook_event_name: "PreToolUse", tool_name: "mcp_linear_get_issue", tool_input: {} });
  assert.equal(other.tool.canonicalName, "mcp:linear:get_issue");
  const native = decode({ ...base, hook_event_name: "PreToolUse", tool_name: "execute_bash", tool_input: { command: "ls" } });
  assert.equal(native.tool.canonicalName, "Bash"); // D-HF-KIRO-SHELL-1: execute_bash is the shell tool
  const other2 = decode({ ...base, hook_event_name: "PreToolUse", tool_name: "fs_write", tool_input: {} });
  assert.equal(other2.tool.canonicalName, "fs_write", "other native names unchanged");
  const odd = decode({ ...base, hook_event_name: "PreToolUse", tool_name: "mcp_x", tool_input: [1] });
  assert.deepEqual(odd.tool, { name: "mcp_x", canonicalName: "mcp_x", input: {} });
});

test("decode never sets a subagent marker (Q24 item 7)", () => {
  const ev = decode({ ...base, hook_event_name: "PreToolUse", tool_name: "execute_bash", tool_input: {}, agent_id: "sub-1", agent_type: "worker" });
  assert.equal("agentId" in ev, false);
  assert.equal("agentType" in ev, false);
});

test("decode PostToolUse reads tool_response text and size; isError false (no documented error field)", () => {
  const ok = decode({ ...base, hook_event_name: "PostToolUse", tool_name: "execute_bash", tool_input: {}, tool_response: "out" });
  assert.deepEqual(ok.result, { isError: false, bytes: 3, text: "out" });
  const obj = decode({ ...base, hook_event_name: "PostToolUse", tool_name: "execute_bash", tool_input: {}, tool_response: { a: "é" } });
  assert.deepEqual(obj.result, { isError: false, bytes: Buffer.byteLength('{"a":"é"}'), text: '{"a":"é"}' });
  const none = decode({ ...base, hook_event_name: "PostToolUse", tool_name: "execute_bash", tool_input: {} });
  assert.deepEqual(none.result, { isError: false, bytes: 0, text: "" });
});

test("decode missing session_id/cwd gives empty strings", () => {
  assert.deepEqual(decode({ hook_event_name: "SessionStart" }), { event: "SessionStart", agent: "kiro", sessionId: "", cwd: "" });
});

// D-FU-RM-KIRO-2: the build writes trigger UserPromptSubmit (D-FU-RM-KIRO-1) and the Kiro docs' prompt hook
// payload has hook_event_name "UserPromptSubmit", so decode must accept it.
test("decode UserPromptSubmit (the trigger the build writes) reads the prompt from env USER_PROMPT only", () => {
  withPrompt("run tests", () => {
    const ev = decode({ ...base, hook_event_name: "UserPromptSubmit", prompt: "stdin field is ignored" });
    assert.deepEqual(ev, { event: "UserPromptSubmit", agent: "kiro", sessionId: "k-1", cwd: "/tmp/proj", prompt: "run tests" });
  });
  withPrompt(undefined, () => {
    assert.equal("prompt" in decode({ ...base, hook_event_name: "UserPromptSubmit" }), false);
  });
});

test("decode throws on unknown event names and non-object payloads", () => {
  assert.throws(() => decode({ ...base, hook_event_name: "PreCompact" }));
  assert.throws(() => decode({ ...base, hook_event_name: "Stop" }));
  assert.throws(() => decode(undefined));
  assert.throws(() => decode(null));
  assert.throws(() => decode([1]));
});

const ev = (event) => ({ event, agent: "kiro", sessionId: "k-1", cwd: "/tmp/proj" });
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"];

test("encode allow is stdout \"\" exit 0 on every event", () => {
  for (const e of EVENTS) assert.deepEqual(encode(ev(e), { kind: "allow" }), { stdout: "", exitCode: 0 });
});

test("encode UserPromptSubmit is stdout \"\" exit 0 for every decision kind (A28, v1 ff0a9a26)", () => {
  const all = [
    { kind: "allow" },
    { kind: "hint", text: "use ctx_search", onceKey: "k" },
    { kind: "deny", reason: "why" },
    { kind: "replace", output: "x" },
  ];
  for (const d of all) {
    const out = encode(ev("UserPromptSubmit"), d);
    assert.strictEqual(out.stdout, "");
    assert.strictEqual(out.exitCode, 0);
  }
});

test("encode hint is plain text stdout exit 0, never JSON; empty text is \"\"", () => {
  for (const e of ["SessionStart", "PreToolUse", "PostToolUse"]) {
    assert.deepEqual(encode(ev(e), { kind: "hint", text: "prefer ctx_execute", onceKey: "k" }), { stdout: "prefer ctx_execute", exitCode: 0 });
    assert.deepEqual(encode(ev(e), { kind: "hint", text: "", onceKey: "k" }), { stdout: "", exitCode: 0 });
  }
});

// D-HF-KIRO-SHELL-1: exit 2 returns STDERR to the agent (Kiro CLI 2.x reference), so the reason goes on stderr.
test("encode deny exits 2 with the plain-text reason on stderr, rewritten command first, never JSON", () => {
  assert.deepEqual(encode(ev("PreToolUse"), { kind: "deny", reason: "why" }), { stdout: "", stderr: "why", exitCode: 2 });
  const out = encode(ev("PreToolUse"), { kind: "deny", reason: "why", rewritten: "node /x/run.mjs abc" });
  assert.deepEqual(out, { stdout: "", stderr: "node /x/run.mjs abc\nwhy", exitCode: 2 });
  assert.throws(() => JSON.parse(out.stderr));
});

test("encode replace is a no-op on Kiro (no replace channel, Q24 item 7)", () => {
  for (const e of EVENTS) assert.deepEqual(encode(ev(e), { kind: "replace", output: "x" }), { stdout: "", exitCode: 0 });
});

// D-N7-KIRO-1: names from Kiro CLI V3 docs. Event names: https://kiro.dev/docs/cli/v3/hooks-migration/ (updated 2026-10-10):
// 2.x agentSpawn/userPromptSubmit/preToolUse/postToolUse/stop became SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop.
// Tool names: https://kiro.dev/docs/custom-agents/configuration-reference/ (2026-10-10): built-in ids execute_bash, execute_pwsh;
// category tag "shell" (the registered matcher) selects them. Kiro CLI 2.34.2 (kiro-cli-chat strings) lists the tool as "shell",
// "Also known as execute_bash (legacy alias)". Every name the "shell" matcher can deliver must decode as the shell tool.
test("[D-N7-KIRO-1] documented camelCase events decode: preToolUse, postToolUse (and agentSpawn, userPromptSubmit)", () => {
  const pre = decode({ ...base, hook_event_name: "preToolUse", tool_name: "execute_bash", tool_input: { command: "cat x" } });
  assert.equal(pre.event, "PreToolUse");
  assert.equal(pre.tool.canonicalName, "Bash");
  const post = decode({ ...base, hook_event_name: "postToolUse", tool_name: "execute_bash", tool_input: {}, tool_response: "out" });
  assert.equal(post.event, "PostToolUse");
  assert.equal(post.result.text, "out");
  assert.equal(decode({ ...base, hook_event_name: "agentSpawn" }).event, "SessionStart");
});

test("[D-N7-KIRO-1] every tool the registered shell matcher selects decodes as the shell tool", () => {
  for (const name of ["execute_bash", "execute_pwsh", "shell"]) {
    const ev = decode({ ...base, hook_event_name: "PreToolUse", tool_name: name, tool_input: { command: "ls" } });
    assert.equal(ev.tool.canonicalName, "Bash", name);
  }
  assert.equal(decode({ ...base, hook_event_name: "PreToolUse", tool_name: "fs_read", tool_input: {} }).tool.canonicalName, "fs_read");
});

test("[D-N7-KIRO-1] an undocumented event name still throws", () => {
  assert.throws(() => decode({ ...base, hook_event_name: "pretooluse" }), /kiro: unknown hook event pretooluse/);
});

test("[D-N7-KIRO-1] the table's shell names are exactly the ones the decoder maps to Bash", async () => {
  const { getAdapter } = await import("../../../src/adapters/table.ts");
  for (const name of getAdapter("kiro").nativeTools.shell) {
    assert.equal(decode({ ...base, hook_event_name: "PreToolUse", tool_name: name, tool_input: {} }).tool.canonicalName, "Bash", name);
  }
});
