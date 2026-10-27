// tests/v2/hooks/saving-live-shapes.test.mjs
// Spec: docs/v2/adr/0020-hooks-and-skills-on-every-agent.md decision 4 (every agent saves, one effect per host).
// Live probe failures of 2026-10-26 (D-HA-QWEN-DUMP-1, D-HA-COPILOT-NAMES-1, D-HA-COPILOT-REPLACE-1, D-HA-PI-PROJECT-1):
// a `cat` of a large log reached the model whole on qwen 0.26.1, copilot-cli 1.0.103 and pi 1.4.0.
// Payloads are the host's documented shapes: qwen hooks doc (Claude shape, run_shell_command), copilot SDK
// types.d.ts (toolName "bash", toolResult {resultType, textResultForLlm}; out modifiedResult), pi 1.4.0
// dist/core/extensions/types.d.ts (tool_call / tool_result, toolName "bash" / "read").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleHook } from "../../../src/core/hooks/dispatch.ts";
import { decode as copilotDecode } from "../../../src/adapters/copilot-cli.ts";
import { READ_DENY_MESSAGE } from "../../../src/core/policy/read-deny.ts";
import { getAdapter } from "../../../src/adapters/table.ts";

// D-M3-F-9: a hook or detached write keeps its DB handle open by design (A21), and Windows cannot delete
// an open file, so temp cleanup there is best-effort. The assertions are unchanged.
function rmTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
}

function bigLog() {
  const lines = [];
  for (let i = 0; i < 4000; i++) lines.push("line " + i + (i === 3001 ? " FATAL disk quota code=QX-7731-ZETA" : " filler words here"));
  return lines.join("\n") + "\n";
}

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "cm-live-shape-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { process.env.HOME = oldHome; rmTemp(root); });
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(path.join(repo, "logs"));
  const big = bigLog();
  writeFileSync(path.join(repo, "logs", "app.log"), big);
  return { root, repo, big, env: { HOME: root, PATH: process.env.PATH } };
}

test("qwen PreToolUse run_shell_command `cat <large file>` is denied with the ctx_execute redirect (no replace on qwen)", async (t) => {
  const { repo, env } = sandbox(t);
  const out = await handleHook("qwen", { session_id: "q1", transcript_path: "/tmp/t.json", cwd: repo, hook_event_name: "PreToolUse",
    permission_mode: "default", tool_name: "run_shell_command", tool_input: { command: "cat logs/app.log" }, tool_use_id: "u1" }, env);
  assert.equal(out.exitCode, 0);
  const j = JSON.parse(out.stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "deny");
  const abs = path.join(repo, "logs", "app.log");
  assert.equal(j.hookSpecificOutput.permissionDecisionReason, READ_DENY_MESSAGE(abs, statSync(abs).size, getAdapter("qwen").toolNamePrefix));
});

test("copilot-cli preToolUse with the host's lowercase `bash` tool reaches the shell rules", async (t) => {
  const { repo, env } = sandbox(t);
  const out = await handleHook("copilot-cli", { hookEventName: "preToolUse", sessionId: "c1", timestamp: 1, cwd: repo,
    toolName: "bash", toolArgs: { command: "curl -s https://x.io/a.json" } }, env);
  assert.equal(out.exitCode, 0);
  const d = copilotDecode({ hookEventName: "preToolUse", sessionId: "c1", cwd: repo, toolName: "bash", toolArgs: { command: "ls" } });
  assert.equal(d.tool.canonicalName, "Bash");
  // copilot-cli has a replace channel (modifiedResult), so the size-guess curl deny does not run: the call runs, then is replaced.
  assert.equal(out.stdout, "");
});

test("copilot-cli postToolUse with a large bash result is replaced through modifiedResult", async (t) => {
  const { repo, big, env } = sandbox(t);
  const out = await handleHook("copilot-cli", { hookEventName: "postToolUse", sessionId: "c1", timestamp: 1, cwd: repo,
    toolName: "bash", toolArgs: { command: "cat logs/app.log", description: "FATAL" },
    toolResult: { resultType: "success", textResultForLlm: big } }, env);
  assert.equal(out.exitCode, 0);
  const j = JSON.parse(out.stdout);
  assert.equal(j.modifiedResult.resultType, "success");
  assert.ok(Buffer.byteLength(j.modifiedResult.textResultForLlm) < Buffer.byteLength(big) / 2, "replaced text is under half the raw output");
  assert.ok(j.modifiedResult.textResultForLlm.includes("ctx_search("), "the replace names ctx_search for the rest");
});

test("copilot-cli snake_case PostToolUse reads tool_result.text_result_for_llm", () => {
  const ev = copilotDecode({ hook_event_name: "PostToolUse", session_id: "c1", cwd: "/tmp", tool_name: "bash", tool_input: {},
    tool_result: { result_type: "success", text_result_for_llm: "abc" } });
  assert.deepEqual(ev.result, { isError: false, bytes: 3, text: "abc" });
  const failed = copilotDecode({ hook_event_name: "PostToolUse", session_id: "c1", cwd: "/tmp", tool_name: "bash", tool_input: {},
    tool_result: { result_type: "failure", text_result_for_llm: "boom" } });
  assert.equal(failed.result.isError, true);
});

async function piHandlers(repo) {
  const { default: piExtension } = await import("../../../src/entries/pi.ts");
  const handlers = {};
  piExtension({ on: (e, h) => { handlers[e] = h; }, registerTool: () => {} });
  const ctx = { cwd: repo, sessionManager: { getSessionId: () => "p1" } };
  await handlers.before_agent_start({ systemPrompt: "base" }, ctx);
  return { handlers, ctx };
}

test("pi tool_call `read` of a large file is blocked with the ctx_execute redirect", async (t) => {
  const { repo } = sandbox(t);
  const { handlers, ctx } = await piHandlers(repo);
  const r = await handlers.tool_call({ type: "tool_call", toolCallId: "c2", toolName: "read", input: { path: "logs/app.log" } }, ctx);
  assert.equal(r?.block, true);
  assert.ok(r.reason.includes("ctx_execute"));
});

test("pi tool_result of a large bash output is replaced (content and details)", async (t) => {
  const { repo, big } = sandbox(t);
  const { handlers, ctx } = await piHandlers(repo);
  const input = { command: "cat logs/app.log" };
  const pre = await handlers.tool_call({ type: "tool_call", toolCallId: "c1", toolName: "bash", input }, ctx);
  assert.equal(pre, undefined, "pi has replace: the bash call runs");
  const r = await handlers.tool_result({ type: "tool_result", toolCallId: "c1", toolName: "bash", input,
    content: [{ type: "text", text: big }], isError: false, details: undefined }, ctx);
  assert.ok(r !== undefined, "the large result is replaced");
  const text = r.content[0].text;
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(big) / 2, "replaced text is under half the raw output");
  assert.ok(text.includes("ctx_search("));
});

// D-HQ-COPILOT-EVENT-1: the documented copilot-cli payload has no hookEventName; the hook must still save.
test("copilot-cli documented postToolUse payload (no hookEventName) is replaced through modifiedResult", async (t) => {
  const { repo, big, env } = sandbox(t);
  const out = await handleHook("copilot-cli", { sessionId: "c1", timestamp: 1, cwd: repo,
    toolName: "bash", toolArgs: JSON.stringify({ command: "cat logs/app.log" }),
    toolResult: { resultType: "success", textResultForLlm: big } }, env);
  assert.equal(out.exitCode, 0);
  const j = JSON.parse(out.stdout);
  assert.equal(j.modifiedResult.resultType, "success");
  assert.ok(Buffer.byteLength(j.modifiedResult.textResultForLlm) < Buffer.byteLength(big) / 2, "replaced text is under half the raw output");
  assert.ok(j.modifiedResult.textResultForLlm.includes("ctx_search("), "the replace names ctx_search for the rest");
});

// D-HA-GEMINI-DUMP-1: gemini-cli 0.65.0 docs/hooks/reference.md BeforeTool: decision "deny" stops the tool and the
// reason goes to the agent. A one-file shell dump over the cap is stopped before it runs, as on every other deny host.
test("gemini BeforeTool run_shell_command `cat <large file>` is denied before it runs, with the prefixed ctx_execute redirect", async (t) => {
  const { repo, env } = sandbox(t);
  const out = await handleHook("gemini", { session_id: "g1", transcript_path: "", cwd: repo, hook_event_name: "BeforeTool",
    timestamp: "2026-10-26T00:00:00Z", tool_name: "run_shell_command", tool_input: { command: "cat logs/app.log" } }, env);
  assert.equal(out.exitCode, 0);
  const j = JSON.parse(out.stdout);
  assert.equal(j.decision, "deny");
  const abs = path.join(repo, "logs", "app.log");
  assert.equal(j.reason, READ_DENY_MESSAGE(abs, statSync(abs).size, getAdapter("gemini").toolNamePrefix));
  assert.ok(j.reason.includes("mcp_context-mode_ctx_execute("), j.reason);
});

test("gemini BeforeTool run_shell_command `cat <small file>` still runs", async (t) => {
  const { repo, env } = sandbox(t);
  writeFileSync(path.join(repo, "small.txt"), "tiny\n");
  const out = await handleHook("gemini", { session_id: "g1", transcript_path: "", cwd: repo, hook_event_name: "BeforeTool",
    timestamp: "2026-10-26T00:00:00Z", tool_name: "run_shell_command", tool_input: { command: "cat small.txt" } }, env);
  assert.equal(out.exitCode, 0);
  assert.equal(out.stdout, "");
});

// D-HA-GEMINI-HINT-1: the AfterTool handle line is the hint the agent runs next. With the session prompt naming the
// FATAL line, that exact ctx_search call returns the FATAL line (before, the bare command matched nothing in the
// source and H9 listed the first chunks by position).
test("gemini AfterTool handle line: the ctx_search it names returns the FATAL line the prompt asks for", async (t) => {
  const { repo, big, env } = sandbox(t);
  const { ctxSearch } = await import("../../../src/core/tools/search.ts");
  const { resolveProject } = await import("../../../src/core/project/resolve.ts");
  const base = { session_id: "g1", transcript_path: "", cwd: repo, timestamp: "2026-10-26T00:00:00Z" };
  await handleHook("gemini", { ...base, hook_event_name: "BeforeAgent", prompt: "read logs/app.log with a shell cat and tell me the value on the FATAL line" }, env);
  const out = await handleHook("gemini", { ...base, hook_event_name: "AfterTool", tool_name: "run_shell_command",
    tool_input: { command: "cat logs/app.log" }, tool_response: { llmContent: big, returnDisplay: big } }, env);
  const reason = JSON.parse(out.stdout).reason;
  const hl = reason.slice(reason.lastIndexOf("\n") + 1);
  assert.ok(hl.startsWith("mcp_context-mode_ctx_search({queries:["), hl);
  const queries = JSON.parse(hl.slice(hl.indexOf("queries:") + 8, hl.indexOf("], source:") + 1));
  const source = JSON.parse(hl.slice(hl.indexOf("source:") + 7, hl.indexOf("})")));
  const project = resolveProject("gemini", { env, argv: [], cwd: repo });
  const ctx = { project, sessionId: "g1", turn: 1, signal: new AbortController().signal };
  // The output is over SYNC_INDEX_MAX_BYTES, so its chunks are written detached: wait for them, then assert.
  let text = "";
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    text = (await ctxSearch.handler({ queries, source }, ctx)).text;
    if (text.includes("QX-7731-ZETA")) break;
  }
  assert.ok(text.includes("FATAL disk quota code=QX-7731-ZETA"), hl + "\n" + text.slice(0, 400));
});
