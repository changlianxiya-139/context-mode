// Pure parts of the published-package live runner for Claude Code (e2e/live/npm-package/claude-code.mjs):
// the 200 KB fixture with one FATAL line, the transcript scorer and the login isolation env. No model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fatalLog, FATAL_VALUE, scoreArm, childEnv, PROMPT } from "../../../e2e/live/npm-package/claude-code.mjs";

const L = (o) => JSON.stringify(o);

test("fixture: about 200 KB with exactly one FATAL line that holds the value", () => {
  const s = fatalLog();
  const bytes = Buffer.byteLength(s);
  assert.ok(bytes >= 190000 && bytes <= 230000, `log is ${bytes} bytes`);
  const fatal = s.split("\n").filter((l) => l.includes("FATAL"));
  assert.equal(fatal.length, 1);
  assert.ok(fatal[0].includes(FATAL_VALUE));
  assert.equal(PROMPT, "read logs/app.log with a shell cat and tell me the value on the FATAL line");
});

test("scoreArm: bytes from tool_result, answer from result, hook fired from PreToolUse/PostToolUse hook events", () => {
  const out = [
    L({ type: "system", subtype: "init", mcp_servers: [{ name: "plugin:context-mode:context-mode", status: "connected" }] }),
    L({ type: "system", subtype: "hook_response", hook_event: "SessionStart", stdout: "x" }),
    L({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "cat logs/app.log" } }] } }),
    L({ type: "system", subtype: "hook_response", hook_event: "PreToolUse", stdout: "{}" }),
    L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "12345" }] } }),
    L({ type: "assistant", message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "mcp__plugin_context-mode_context-mode__ctx_search", input: {} }] } }),
    L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "abc" }] }] } }),
    L({ type: "result", result: `The value is ${FATAL_VALUE}.`, total_cost_usd: 0.02, is_error: false }),
  ].join("\n");
  const r = scoreArm(out);
  assert.equal(r.bytes, 8);
  assert.equal(r.answerOk, true);
  assert.equal(r.hookFired, true);
  assert.deepEqual(r.tools, ["Bash", "mcp__plugin_context-mode_context-mode__ctx_search"]);
  assert.equal(r.mcpConnected, true);
  assert.equal(r.costUsd, 0.02);
});

test("scoreArm: no tool hook event and a wrong answer score false", () => {
  const out = [
    L({ type: "system", subtype: "hook_response", hook_event: "SessionStart", stdout: "x" }),
    L({ type: "result", result: "I do not know.", total_cost_usd: 0, is_error: false }),
  ].join("\n");
  const r = scoreArm(out);
  assert.equal(r.hookFired, false);
  assert.equal(r.answerOk, false);
  assert.equal(r.bytes, 0);
  assert.equal(r.mcpConnected, false);
});

test("childEnv: own HOME, config dir under that HOME, no API key, no parent CLAUDE_* leak", () => {
  process.env.ANTHROPIC_API_KEY = "leak"; process.env.CLAUDE_CONFIG_DIR = "/leak";
  try {
    const e = childEnv("/sb/home", "/sb/bin:/x");
    assert.equal(e.HOME, "/sb/home");
    assert.equal(e.CLAUDE_CONFIG_DIR, "/sb/home/.claude");
    assert.equal(e.PATH, "/sb/bin:/x");
    assert.equal(e.ANTHROPIC_API_KEY, undefined);
    assert.equal(e.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(e.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(e.CLAUDE_CODE_DISABLE_CLAUDE_MDS, "1");
  } finally { delete process.env.ANTHROPIC_API_KEY; delete process.env.CLAUDE_CONFIG_DIR; }
});
