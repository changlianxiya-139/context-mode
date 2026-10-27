// Unit tests for src/core/hooks/dispatch.ts (impl/09 §4, ADR-0009 §1 and §6, ADR-0016, DECISIONS-r9 F1;
// DEVIATIONS D-M3-arch-2, D-M3-arch-3, D-M3-H2-*). handleHook(agent, raw, env) never throws.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { handleHook } from "../../../src/core/hooks/dispatch.ts";
import { ctxSearch } from "../../../src/core/tools/search.ts";
import { chunkText } from "../../../src/core/index/chunk.ts";
import { getAdapter } from "../../../src/adapters/table.ts";
import {
  COMPACT_POINTER_LINE, OUTPUT_CAP, REPLACE_TRIGGER_BYTES, REPLACE_RETURN_BYTES, REPLACE_CHUNK_BYTES, SYNC_INDEX_MAX_BYTES, PENDING_COMPACT_META_PREFIX,
} from "../../../src/core/contracts/constants.ts";

// D-M3-F-9: a hook or detached write keeps its DB handle open by design (A21), and Windows cannot delete
// an open file, so temp cleanup there is best-effort. The assertions above it are unchanged.
// D-HL-NAMES-1: hook texts name tools as claude-code calls them (its toolNamePrefix + ctx_*).
const CCP = getAdapter("claude-code").toolNamePrefix;

function rmTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
}

let root;
let repo;
let oldHome;
let env;

before(() => {
  root = mkdtempSync(join(tmpdir(), "cm-dispatch-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  oldHome = process.env.HOME;
  process.env.HOME = root; process.env.USERPROFILE = root; // resolveConfigDir reads the process env (D-M1-T3-5)
  env = { HOME: root, CLAUDE_PROJECT_DIR: repo, PATH: process.env.PATH };
  mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
  writeFileSync(join(repo, ".claude", "agents", "reader.md"), "---\nname: reader\ntools: Read\n---\nreads\n");
  writeFileSync(join(repo, ".claude", "agents", "sheller.md"), "---\nname: sheller\ntools: Bash\n---\nruns\n");
});

after(() => {
  process.env.HOME = oldHome;
  rmTemp(root);
});

function dbFile() {
  const projects = join(root, ".context-mode", "projects");
  if (!existsSync(projects)) return null;
  const keys = readdirSync(projects);
  return keys.length === 0 ? null : join(projects, keys[0], "context.db");
}

function query(sql, ...args) {
  const f = dbFile();
  if (f === null || !existsSync(f)) return [];
  const db = new DatabaseSync(f, { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

async function waitRows(sql, args, n) {
  const end = Date.now() + 5000;
  for (;;) {
    const rows = query(sql, ...args);
    if (rows.length >= n || Date.now() > end) return rows;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function cc(fields) {
  return { session_id: "s-" + Math.random().toString(36).slice(2), cwd: repo, ...fields };
}

// D-M7-SV-1: a Bash replace is the Bash output shape {stdout, stderr, interrupted}; other tools get a string.
function replacedText(v) {
  if (typeof v === "string") return v;
  assert.deepEqual(Object.keys(v).sort(), ["interrupted", "stderr", "stdout"]);
  assert.equal(v.stderr, "");
  assert.equal(v.interrupted, false);
  return v.stdout;
}

function parsed(out) {
  assert.equal(out.exitCode, 0);
  return out.stdout === "" ? null : JSON.parse(out.stdout).hookSpecificOutput;
}

function captureStderr() {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c) => { lines.push(String(c)); return true; };
  return { lines, restore: () => { process.stderr.write = orig; } };
}

test("unknown agent id: empty stdout, exit 0", async () => {
  assert.deepEqual(await handleHook("nope", {}, env), { stdout: "", exitCode: 0 });
});

test("decode failure: allow shape and one stderr line", async () => {
  const cap = captureStderr();
  let out;
  try { out = await handleHook("claude-code", { hook_event_name: "Nope" }, env); } finally { cap.restore(); }
  assert.deepEqual(out, { stdout: "", exitCode: 0 });
  assert.equal(cap.lines.length, 1);
  assert.ok(cap.lines[0].startsWith("hooks: decode failed: "));
});

test("no project: allow, no hint, no DB", async () => {
  const bare = { HOME: root, PATH: process.env.PATH };
  const out = await handleHook("claude-code", cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "curl https://x.y" } }), bare);
  assert.deepEqual(out, { stdout: "", exitCode: 0 });
});

test("SessionStart startup: resume hint once per session (GP3/hint-once-per-session)", async () => {
  const p = cc({ hook_event_name: "SessionStart", source: "startup" });
  const first = parsed(await handleHook("claude-code", p, env));
  assert.ok(first.additionalContext.includes("mcp__plugin_context-mode_context-mode__ctx_resume"));
  assert.equal(await handleHook("claude-code", p, env).then((o) => o.stdout), "");
});

test("GP6/hint-names-platform-tool: Codex resume hint names mcp__context_mode__ctx_resume", async () => {
  const out = await handleHook("codex", cc({ hook_event_name: "SessionStart", source: "startup" }), env);
  assert.ok(parsed(out).additionalContext.includes("mcp__context_mode__ctx_resume"));
});

test("SessionStart compact on claude-code (compactSummary none, D-M7-CL-1): the renderState block, not the pointer", async () => {
  const out = await handleHook("claude-code", cc({ hook_event_name: "SessionStart", source: "compact" }), env);
  const text = parsed(out).additionalContext;
  assert.ok(text.startsWith("<context_mode_state ") && text !== COMPACT_POINTER_LINE, text);
});

test("SessionStart compact on codex (compactSummary none): the renderState block, not the pointer (M4, D-M4-H2-4)", async () => {
  const out = await handleHook("codex", cc({ hook_event_name: "SessionStart", source: "compact" }), env);
  const text = parsed(out).additionalContext;
  assert.ok(text.startsWith("<context_mode_state ") && text !== COMPACT_POINTER_LINE, text);
});

test("UserPromptSubmit: detached prompt row, allow", async () => {
  const p = cc({ hook_event_name: "UserPromptSubmit", prompt: "find the bug" });
  const out = await handleHook("claude-code", p, env);
  assert.deepEqual(out, { stdout: "", exitCode: 0 });
  const rows = await waitRows("SELECT kind, body, ok FROM events WHERE session_id = ?", [p.session_id], 1);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ kind: "prompt", body: "find the bug", ok: 1 }]);
});

test("PreCompact (vscode, pending-flag): sets the pending_compact meta key", async () => {
  // D-HF-VSCODE-PROJECT-1: a vscode hook resolves its project from the payload cwd.
  const p = cc({ hook_event_name: "PreCompact" });
  await handleHook("vscode", p, { ...env, CLAUDE_PROJECT_DIR: "" });
  assert.deepEqual(query("SELECT value FROM meta WHERE key = ?", PENDING_COMPACT_META_PREFIX + p.session_id).map((r) => r.value), ["1"]);
  // No cwd in the payload: no project, so no flag.
  const q = cc({ hook_event_name: "PreCompact", cwd: "" });
  await handleHook("vscode", q, { ...env, CLAUDE_PROJECT_DIR: "" });
  assert.equal(query("SELECT value FROM meta WHERE key = ?", PENDING_COMPACT_META_PREFIX + q.session_id).length, 0);
});

test("PreCompact (gemini PreCompress, pending-flag): sets pending_compact:<sid> = 1 (ADR-0009 §6)", async () => {
  const p = cc({ hook_event_name: "PreCompress" });
  const out = await handleHook("gemini", p, env);
  assert.deepEqual(out, { stdout: "", exitCode: 0 });
  const rows = query("SELECT value FROM meta WHERE key = ?", PENDING_COMPACT_META_PREFIX + p.session_id);
  assert.deepEqual(rows.map((r) => r.value), ["1"]);
});

// D-M7-RR-1: claude-code now allows curl (run, then replace); codex (no replace) keeps the deny.
test("PreToolUse curl: deny, never updatedInput (GP3/no-updated-input-rewrite)", async () => {
  const out = parsed(await handleHook("codex", cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "curl https://example.com" } }), env));
  assert.equal(out.permissionDecision, "deny");
  assert.equal("updatedInput" in out, false);
});

test("PreToolUse ctx_execute: empty stdout, no fields (GP3/no-empty-fields)", async () => {
  const out = await handleHook("claude-code", cc({ hook_event_name: "PreToolUse", tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute", tool_input: { language: "shell", code: "ls" } }), env);
  assert.deepEqual(out, { stdout: "", exitCode: 0 });
});

// D-M7-RR-2 (owner decision 2026-10-20): no PreToolUse/PostToolUse hint on any row; these were hint tests.
test("PreToolUse Bash, Grep, Read, other MCP: empty allow, no hint, every call (D-M7-RR-2)", async () => {
  const calls = [
    ["Bash", { command: "ls" }], ["Bash", { command: "npm test" }], ["Grep", { pattern: "x" }],
    ["Read", { file_path: join(repo, "nope.txt") }], ["mcp__foo__bar", {}],
  ];
  for (const [tool_name, tool_input] of calls) {
    const p = cc({ hook_event_name: "PreToolUse", tool_name, tool_input });
    for (let i = 0; i < 3; i++) assert.deepEqual(await handleHook("claude-code", p, env), { stdout: "", exitCode: 0 }, tool_name);
  }
});

test("PostToolUse at or under REPLACE_TRIGGER_BYTES: empty allow, zero added bytes (D-M7-RR-1, D-M7-SV-1)", async () => {
  for (const agent of ["claude-code", "codex"]) {
    const p = cc({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "x".repeat(REPLACE_TRIGGER_BYTES - 10), stderr: "" } });
    assert.deepEqual(await handleHook(agent, p, env), { stdout: "", exitCode: 0 }, agent);
  }
});

test("GP3/tool-prefix-standalone-mcp: Qwen PreToolUse shell gets no hint (D-M7-RR-2)", async () => {
  const out = await handleHook("qwen", cc({ hook_event_name: "PreToolUse", tool_name: "run_shell_command", tool_input: { command: "ls" } }), { ...env });
  assert.equal(out.stdout, "");
});

test("GP6/no-false-shell-error-capture: Bash exit 0 with 'Error' text is a cmd row, ok 1", async () => {
  const p = cc({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo  'Error: none'" }, tool_response: "Error: none" });
  await handleHook("claude-code", p, env);
  const rows = await waitRows("SELECT kind, ok, key, exit_code FROM events WHERE session_id = ?", [p.session_id], 1);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ kind: "cmd", ok: 1, key: "Bash:echo 'Error: none'", exit_code: null }]);
});

test("PostToolUse failure: toolerr row with stable JSON key and the Exit code digits", async () => {
  const p = cc({ hook_event_name: "PostToolUse", tool_name: "Grep", tool_input: { pattern: "x", path: "src" }, tool_response: { is_error: true, content: "Exit code 2\nboom" } });
  await handleHook("claude-code", p, env);
  const rows = await waitRows("SELECT kind, ok, key, path FROM events WHERE session_id = ?", [p.session_id], 1);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ kind: "toolerr", ok: 0, key: 'Grep:{"path":"src","pattern":"x"}', path: "src" }]);
});

test("PostToolUse Edit: edit row with the file path", async () => {
  const p = cc({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/a/b.ts" }, tool_response: "ok" });
  await handleHook("claude-code", p, env);
  const rows = await waitRows("SELECT kind, path FROM events WHERE session_id = ?", [p.session_id], 1);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ kind: "edit", path: "/a/b.ts" }]);
});

test("PostToolUse: clean Read and own ctx_* tool write no row (A25, ADR-0009 §0)", async () => {
  const p = cc({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/x" }, tool_response: "text" });
  const q = cc({ hook_event_name: "PostToolUse", tool_name: "mcp__plugin_context-mode_context-mode__ctx_search", tool_input: {}, tool_response: "x" });
  await handleHook("claude-code", p, env);
  await handleHook("claude-code", q, env);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(query("SELECT 1 FROM events WHERE session_id IN (?, ?)", p.session_id, q.session_id).length, 0);
});

function bigText(bytes) {
  const lines = [];
  let n = 0;
  for (let i = 0; n < bytes; i++) {
    const l = "line " + i + (i % 50 === 0 ? " needle target" : " filler words here") + "\n";
    lines.push(l);
    n += l.length;
  }
  return lines.join("");
}

function subagentPost(text, type) {
  return cc({ hook_event_name: "PostToolUse", agent_id: "sub-1", agent_type: type, tool_name: "Read", tool_input: { file_path: "/big.log", description: "needle target" }, tool_response: text });
}

test("case C under OUTPUT_CAP: allow, nothing indexed", async () => {
  const out = await handleHook("claude-code", subagentPost("small", "reader"), env);
  assert.equal(out.stdout, "");
});

test("case C, OUTPUT_CAP < bytes <= SYNC_INDEX_MAX_BYTES: indexed inline, whole chunks replace (F1)", async () => {
  const text = bigText(40000);
  const p = subagentPost(text, "reader");
  const out = parsed(await handleHook("claude-code", p, env));
  const replaced = out.updatedToolOutput;
  assert.ok(Buffer.byteLength(replaced) <= REPLACE_RETURN_BYTES + 512, "within budget plus the more line");
  assert.ok(replaced.includes("needle target"));
  const src = query("SELECT label, bytes_total FROM sources WHERE session_id = ?", p.session_id);
  // bytes_total is the sum of chunk bytes (store rule): the trailing newline is not a chunk byte.
  assert.equal(src.length, 1);
  assert.equal(src[0].label, "subagent:Read:0");
  assert.ok(src[0].bytes_total >= Buffer.byteLength(text) - 1, "the whole text is indexed, nothing cut");
  // Whole chunks only: the selected chunks, joined by one "\n", make up the body byte for byte.
  const body = replaced.slice(0, replaced.lastIndexOf("\n" + CCP + "ctx_search(") < 0 ? replaced.length : replaced.lastIndexOf("\n" + CCP + "ctx_search("));
  const whole = chunkText(text, "text", REPLACE_CHUNK_BYTES).filter((c) => body.includes(c.text));
  assert.ok(whole.length > 0);
  const joined = whole.reduce((n, c) => n + Buffer.byteLength(c.text), 0) + whole.length - 1;
  assert.equal(joined, Buffer.byteLength(body), "the body is whole chunks, nothing cut");
});

test("case C, bytes > SYNC_INDEX_MAX_BYTES: in-memory selection, detached index (F1)", async () => {
  const text = bigText(SYNC_INDEX_MAX_BYTES * 2);
  const p = subagentPost(text, "reader");
  const out = parsed(await handleHook("claude-code", p, env));
  assert.ok(Buffer.byteLength(out.updatedToolOutput) <= REPLACE_RETURN_BYTES + 512);
  assert.ok(out.updatedToolOutput.includes("needle target"));
  const src = await waitRows("SELECT label FROM sources WHERE session_id = ?", [p.session_id], 1);
  assert.equal(src.length, 1);
});

test("case B PreToolUse deny: reason names run.mjs next to the hook bundle (D-M3-arch-3)", async () => {
  const cmd = "curl https://example.com/data";
  const p = cc({ hook_event_name: "PreToolUse", agent_id: "sub-2", agent_type: "sheller", tool_name: "Bash", tool_input: { command: cmd } });
  const out = parsed(await handleHook("claude-code", p, env));
  assert.equal(out.permissionDecision, "deny");
  const first = out.permissionDecisionReason.split("\n")[0];
  assert.ok(first.startsWith("node \""));
  assert.ok(first.includes(sep + "run.mjs\" " + Buffer.from(cmd).toString("base64url") + " "));
  // D-M3-F-7: the rest is the case-B text (drafts.md deny-subagent-run); it names no ctx_* tool the subagent lacks.
  const md = readFileSync(new URL("../../../docs/v2/prompt/drafts.md", import.meta.url), "utf8");
  const at = md.indexOf("<!-- id: deny-subagent-run -->");
  const open = md.indexOf("```text\n", at) + "```text\n".length;
  assert.ok(at >= 0);
  assert.equal(out.permissionDecisionReason.slice(first.length + 1), md.slice(open, md.indexOf("\n```", open)));
  assert.equal(out.permissionDecisionReason.includes("ctx_"), false);
});

test("case A subagent (no agent file, inherits ctx tools): same deny as the main session", async () => {
  const p = cc({ hook_event_name: "PreToolUse", agent_id: "sub-3", tool_name: "Bash", tool_input: { command: "curl https://example.com" } });
  const out = parsed(await handleHook("claude-code", p, env));
  assert.equal(out.permissionDecision, "deny");
  assert.equal(out.permissionDecisionReason.startsWith("node "), false);
});

// ---------- D-M7-RR-1: main agent "run, then replace" (owner decision 2026-10-20) ----------

function mainBashPost(stdout, description = "needle target") {
  return cc({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "cat big.log", description }, tool_use_id: "toolu_" + Math.random().toString(36).slice(2), tool_response: { stdout, stderr: "", interrupted: false, isImage: false } });
}

function searchCtx(sessionId) {
  const f = dbFile();
  const projectDir = join(f, "..");
  const projectKey = projectDir.split(sep).pop();
  return {
    project: { projectKey, projectDir, dbPath: f, worktree: repo, containmentRoot: root, agent: "claude-code", source: "env:CLAUDE_PROJECT_DIR" },
    sessionId, turn: 1, signal: new AbortController().signal,
  };
}

test("D-M7-RR-1: main-agent Bash over OUTPUT_CAP on claude-code: selected whole chunks + more line, full output indexed", async () => {
  const text = bigText(40000);
  const p = mainBashPost(text);
  const out = parsed(await handleHook("claude-code", p, env));
  const replaced = replacedText(out.updatedToolOutput);
  assert.equal(typeof replaced, "string");
  assert.ok(Buffer.byteLength(replaced) <= REPLACE_RETURN_BYTES + 512, "within budget plus the more line");
  assert.ok(Buffer.byteLength(replaced) < Buffer.byteLength(text));
  assert.ok(replaced.includes("needle target"));
  const more = replaced.lastIndexOf("\n" + CCP + "ctx_search(");
  assert.ok(more > 0, "the more line names ctx_search");
  const body = replaced.slice(0, more);
  // Whole chunks of the plain stdout (not the JSON tool_response): nothing cut, no escaped newlines.
  const whole = chunkText(text, "text", REPLACE_CHUNK_BYTES).filter((c) => body.includes(c.text));
  assert.ok(whole.length > 0);
  const joined = whole.reduce((n, c) => n + Buffer.byteLength(c.text), 0) + whole.length - 1;
  assert.equal(joined, Buffer.byteLength(body), "the body is whole chunks, nothing cut");
  const src = query("SELECT id, label, bytes_total FROM sources WHERE session_id = ?", p.session_id);
  assert.equal(src.length, 1);
  // D-CR3-HANDLE-1: the more line names the stored source by its short id (ctx_search resolves it to the label).
  assert.ok(replaced.slice(more).includes(JSON.stringify("s" + Number(src[0].id).toString(36))), "the more line names the source id");
  assert.ok(src[0].bytes_total >= Buffer.byteLength(text) - 1, "the whole output is indexed, nothing cut");
  // The full output is findable: a chunk the replace dropped comes back from ctx_search, by a line only it holds.
  const all = chunkText(text, "text", REPLACE_CHUNK_BYTES);
  // D-M7-SV-1: with small chunks the first dropped chunk holds one-digit line numbers, which are not a
  // distinct query; take the first dropped chunk with a line number of 3+ digits (same assertion below).
  const gone = all.find((c) => !body.includes(c.text) && /^line \d{3,} filler/m.test(c.text));
  assert.ok(gone !== undefined, "some chunk was not in the replaced text");
  // D-M7-SV-3: a 48-byte chunk holds one or two whole lines, so the probe line may be the chunk's first line.
  const inner = gone.text.split("\n").find((l) => /^line \d{3,} filler/.test(l));
  const num = inner.split(" ")[1];
  const r = await ctxSearch.handler({ queries: ["line " + num + " filler"], scope: "session", source: src[0].label }, searchCtx(p.session_id));
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes(src[0].label + " #" + gone.ord + ":"), "ctx_search finds the dropped chunk: ord " + gone.ord + " num " + num + "\n" + r.text.slice(0, 600));
});

test("D-M7-RR-3: no Bash description: the intent is the command text, never an empty query", async () => {
  const p = mainBashPost(bigText(40000), undefined);
  delete p.tool_input.description;
  const out = parsed(await handleHook("claude-code", p, env));
  const replaced = replacedText(out.updatedToolOutput);
  const more = replaced.slice(replaced.lastIndexOf("\n" + CCP + "ctx_search("));
  assert.ok(!more.includes('[""]'), "the more line has no empty query: " + more);
  assert.ok(more.includes("cat big.log"), "the more line queries the command text: " + more);
});

test("D-M7-RR-3: no description on Read, Grep, WebFetch: file path, pattern, URL are the intent", async () => {
  for (const [tool, input, want] of [["Read", { file_path: "/tmp/big.log" }, "/tmp/big.log"], ["Grep", { pattern: "needle target" }, "needle target"], ["WebFetch", { url: "https://example.com/x" }, "https://example.com/x"]]) {
    const p = cc({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: input, tool_use_id: "toolu_" + tool, tool_response: bigText(40000) });
    const out = parsed(await handleHook("claude-code", p, env));
    if (typeof out.updatedToolOutput !== "string") continue; // row has no replace channel for this tool
    const replaced = out.updatedToolOutput;
    const more = replaced.slice(replaced.lastIndexOf("\n" + CCP + "ctx_search("));
    assert.ok(!more.includes('[""]'), tool + ": no empty query: " + more);
    assert.ok(more.includes(want), tool + ": the more line queries " + want + ": " + more);
  }
});

test("D-M7-RR-1: main-agent replace above SYNC_INDEX_MAX_BYTES: in-memory selection, detached index", async () => {
  const text = bigText(SYNC_INDEX_MAX_BYTES * 2);
  const p = mainBashPost(text);
  const out = parsed(await handleHook("claude-code", p, env));
  const replaced = replacedText(out.updatedToolOutput);
  assert.ok(Buffer.byteLength(replaced) <= REPLACE_RETURN_BYTES + 512);
  assert.ok(replaced.includes("needle target"));
  const src = await waitRows("SELECT label FROM sources WHERE session_id = ?", [p.session_id], 1);
  assert.equal(src.length, 1);
});

test("D-M7-SV-1: a 4-16K Bash output is replaced by at most REPLACE_RETURN_BYTES of whole small chunks plus the more line", async () => {
  const text = bigText(REPLACE_TRIGGER_BYTES * 2);
  const p = mainBashPost(text);
  const out = parsed(await handleHook("claude-code", p, env));
  const replaced = replacedText(out.updatedToolOutput);
  const more = replaced.lastIndexOf("\n" + CCP + "ctx_search(");
  assert.ok(more > 0, "the more line names ctx_search");
  assert.ok(Buffer.byteLength(replaced.slice(0, more)) <= REPLACE_RETURN_BYTES);
  assert.ok(replaced.includes("needle target"));
  for (const c of chunkText(text, "text", REPLACE_CHUNK_BYTES)) assert.ok(c.bytes <= REPLACE_CHUNK_BYTES);
});

test("D-M7-SV-1: small chunks drop no byte: chunk bytes sum to the text bytes; the default chunking is unchanged", () => {
  const text = bigText(20000);
  const small = chunkText(text, "text", REPLACE_CHUNK_BYTES);
  assert.equal(small.reduce((n, c) => n + c.bytes, 0) + 1, Buffer.byteLength(text), "only the final newline is not a chunk byte");
  assert.deepEqual(chunkText(text, "text", 1 << 30), chunkText(text, "text"));
});

test("D-M2-MCP-1: a large non-ctx MCP result on claude-code is replaced by one text block; the full text is indexed", async () => {
  const text = bigText(40000);
  const p = cc({ hook_event_name: "PostToolUse", tool_name: "mcp__tix__list_tickets", tool_input: { description: "needle target" }, tool_use_id: "toolu_m1", tool_response: [{ type: "text", text }] });
  const out = parsed(await handleHook("claude-code", p, env));
  assert.ok(Array.isArray(out.updatedToolOutput) && out.updatedToolOutput.length === 1 && out.updatedToolOutput[0].type === "text");
  const replaced = out.updatedToolOutput[0].text;
  assert.ok(Buffer.byteLength(replaced) <= REPLACE_RETURN_BYTES + 512 && replaced.includes("needle target"));
  assert.equal(query("SELECT 1 FROM sources WHERE session_id = ?", p.session_id).length, 1);
});

test("D-M2-MCP-1: an MCP result with an image block, or a small one, stays as the host made it", async () => {
  const big = bigText(40000);
  const withImage = cc({ hook_event_name: "PostToolUse", tool_name: "mcp__tix__shot", tool_input: {}, tool_response: [{ type: "text", text: big }, { type: "image", data: "AAAA", mimeType: "image/png" }] });
  assert.deepEqual(await handleHook("claude-code", withImage, env), { stdout: "", exitCode: 0 });
  const small = cc({ hook_event_name: "PostToolUse", tool_name: "mcp__tix__get", tool_input: {}, tool_response: [{ type: "text", text: "tiny" }] });
  assert.deepEqual(await handleHook("claude-code", small, env), { stdout: "", exitCode: 0 });
});

test("D-M2-MCP-1: a large Grep content result keeps the Grep shape and swaps content", async () => {
  const resp = { mode: "content", numFiles: 0, filenames: [], content: bigText(40000), numLines: 900, totalLines: 900, appliedLimit: 250 };
  const p = cc({ hook_event_name: "PostToolUse", tool_name: "Grep", tool_input: { pattern: "needle target" }, tool_use_id: "toolu_g1", tool_response: resp });
  const out = parsed(await handleHook("claude-code", p, env));
  const u = out.updatedToolOutput;
  assert.deepEqual({ ...u, content: 0 }, { ...resp, content: 0 });
  assert.ok(Buffer.byteLength(u.content) < Buffer.byteLength(resp.content) && u.content.includes("needle target"));
});

test("D-M7-RR-1: rows with no replace (codex, qwen) keep their one path: large PostToolUse is the empty allow", async () => {
  for (const agent of ["codex", "qwen"]) {
    const p = mainBashPost(bigText(40000));
    const out = await handleHook(agent, p, env);
    assert.deepEqual(out, { stdout: "", exitCode: 0 }, agent);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(query("SELECT 1 FROM sources WHERE session_id = ?", p.session_id).length, 0, agent + ": nothing indexed");
  }
});

test("D-M7-RR-1: main-agent PreToolUse curl on claude-code is allowed (replace takes over); codex still denies", async () => {
  const p = cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "curl -s https://x.io/a.json" } });
  assert.deepEqual(await handleHook("claude-code", p, env), { stdout: "", exitCode: 0 });
  const c = parsed(await handleHook("codex", p, env));
  assert.equal(c.permissionDecision, "deny");
});

test("D-M7-RR-1: user policy deny and Read deny unchanged on claude-code", async () => {
  mkdirSync(join(repo, ".claude"), { recursive: true });
  const settings = join(repo, ".claude", "settings.json");
  const had = existsSync(settings) ? readFileSync(settings, "utf8") : null;
  writeFileSync(settings, JSON.stringify({ permissions: { deny: ["Bash(rm -rf:*)"] } }));
  try {
    const d = parsed(await handleHook("claude-code", cc({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build" } }), env));
    assert.equal(d.permissionDecision, "deny");
    assert.ok(d.permissionDecisionReason.includes("Bash(rm -rf:*)"));
  } finally {
    if (had === null) rmSync(settings); else writeFileSync(settings, had);
  }
  const big = join(repo, "big-read.log");
  writeFileSync(big, "x".repeat(OUTPUT_CAP * 4));
  const r = parsed(await handleHook("claude-code", cc({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: big } }), env));
  assert.equal(r.permissionDecision, "deny");
});

test("D-M7-SV-2: the replace return budget is at most 512 bytes, a constant of its own under OUTPUT_CAP; a 16K output keeps the intent chunk", async () => {
  assert.ok(REPLACE_RETURN_BYTES <= 512, "D-M7-SV-3 pins the exact value");
  assert.ok(REPLACE_RETURN_BYTES < OUTPUT_CAP && REPLACE_RETURN_BYTES >= 2 * REPLACE_CHUNK_BYTES, "at least two whole chunks fit");
  const text = bigText(16000);
  const out = parsed(await handleHook("claude-code", mainBashPost(text), env));
  const replaced = replacedText(out.updatedToolOutput);
  const more = replaced.lastIndexOf("\n" + CCP + "ctx_search(");
  assert.ok(more > 0, "the more line names ctx_search");
  assert.ok(Buffer.byteLength(replaced.slice(0, more)) <= 512);
  assert.ok(replaced.includes("needle target"));
});

test("D-M7-SV-3: return budget 96 and chunk cap 48; two whole chunks fit; a 16K output keeps the intent line and drops no byte", async () => {
  assert.equal(REPLACE_RETURN_BYTES, 96);
  assert.equal(REPLACE_CHUNK_BYTES, 48);
  assert.ok(REPLACE_RETURN_BYTES >= 2 * REPLACE_CHUNK_BYTES, "at least two whole chunks fit");
  const text = bigText(16000);
  const out = parsed(await handleHook("claude-code", mainBashPost(text), env));
  const replaced = replacedText(out.updatedToolOutput);
  const more = replaced.lastIndexOf("\n" + CCP + "ctx_search(");
  assert.ok(more > 0, "the more line names ctx_search");
  assert.ok(Buffer.byteLength(replaced.slice(0, more)) <= 96);
  assert.ok(replaced.includes("needle target"));
  const chunks = chunkText(text, "text", REPLACE_CHUNK_BYTES);
  for (const c of chunks) assert.ok(c.bytes <= 48);
  assert.equal(chunks.reduce((n, c) => n + c.bytes, 0) + 1, Buffer.byteLength(text), "only the final newline is not a chunk byte");
  const fail = "FAIL suite/gamma/case_1234_abc123 (12ms) expected 3 got 4\n";
  const log = bigText(8000) + fail + bigText(2000);
  assert.ok(chunkText(log, "text", REPLACE_CHUNK_BYTES).some((c) => c.text.includes("FAIL suite/gamma/case_1234_abc123")), "a test id stays in one chunk");
});

// D-M7-SV-5: the replace ranks chunks by the tool intent OR the words of the session's last user prompt,
// so a cat whose command names no content term still returns the line the user asked for.
test("D-M7-SV-5: the replace selection also ranks by the last user prompt; budget, more line and indexing unchanged", async () => {
  const p = cc({ hook_event_name: "UserPromptSubmit", prompt: 'Run cat on data/part1.txt. Find the line starting with SECRET-1 and read the value after "value=".' });
  await handleHook("claude-code", p, env);
  await waitRows("SELECT 1 FROM events WHERE session_id = ? AND kind = 'prompt'", [p.session_id], 1);
  const text = bigText(8000) + "SECRET-1 value=qz7k2m9x\n" + bigText(8000);
  const post = { ...mainBashPost(text, ""), session_id: p.session_id };
  post.tool_input = { command: "cat data/part1.txt" };
  const out = parsed(await handleHook("claude-code", post, env));
  const replaced = replacedText(out.updatedToolOutput);
  const more = replaced.lastIndexOf("\n" + CCP + "ctx_search(");
  assert.ok(more > 0, "the more line names ctx_search");
  assert.ok(Buffer.byteLength(replaced.slice(0, more)) <= REPLACE_RETURN_BYTES);
  assert.ok(replaced.includes("SECRET-1 value=qz7k2m9x"), "the prompt term selects the asked-for line");
  assert.ok(replaced.slice(more).includes(JSON.stringify("cat data/part1.txt")), "the more line keeps the tool intent");
  // No prompt in the session: the selection is the tool intent alone, as before.
  const q = mainBashPost(text, "");
  q.tool_input = { command: "cat data/part1.txt" };
  const alone = replacedText(parsed(await handleHook("claude-code", q, env)).updatedToolOutput);
  assert.equal(alone.includes("SECRET-1 value=qz7k2m9x"), false, "without a prompt the newest chunks win, as before");
});

// D-M2-SHAPE-2: the host persisted the whole output; the hook gets a head only. Dispatch reads the whole file.
test("D-M2-SHAPE-2: a persisted Bash output is indexed and shaped whole; an unreadable file keeps the head", async () => {
  const lines = Array.from({ length: 1500 }, (_, i) => (i === 900 ? "SECRET-2 value=late9x7q" : "row " + i + " a" + i + " b" + i));
  const full = lines.join("\n") + "\n";
  const head = lines.slice(0, 600).join("\n") + "\n";
  const dir = mkdtempSync(join(tmpdir(), "persist-"));
  try {
    const file = join(dir, "out.txt");
    writeFileSync(file, full);
    const u = cc({ hook_event_name: "UserPromptSubmit", prompt: "Run cat on data/part2.txt. Find the line starting with SECRET-2." });
    await handleHook("claude-code", u, env);
    await waitRows("SELECT 1 FROM events WHERE session_id = ? AND kind = 'prompt'", [u.session_id], 1);
    const p = { ...mainBashPost(head, ""), session_id: u.session_id };
    p.tool_input = { command: "cat data/part2.txt" };
    p.tool_response = { stdout: head, stderr: "", interrupted: false, persistedOutputPath: file, persistedOutputSize: Buffer.byteLength(full) };
    const replaced = replacedText(parsed(await handleHook("claude-code", p, env)).updatedToolOutput);
    assert.ok(replaced.includes("SECRET-2 value=late9x7q"), "the line past the head comes back: " + replaced);
    const src = await waitRows("SELECT bytes_total FROM sources WHERE session_id = ?", [p.session_id], 1);
    assert.ok(src[0].bytes_total >= Buffer.byteLength(full) - 1, "the whole file is indexed");
    const q = mainBashPost(head, "");
    q.tool_input = { command: "cat data/part2.txt" };
    q.tool_response = { stdout: head, stderr: "", interrupted: false, persistedOutputPath: join(dir, "none.txt"), persistedOutputSize: Buffer.byteLength(full) };
    const out = replacedText(parsed(await handleHook("claude-code", q, env)).updatedToolOutput);
    assert.equal(out.includes("late9x7q"), false, "unreadable file: the head only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// D-CR3-HANDLE-1 (replaces D-CR2-HANDLE-1): every replacement ends with one handle line: the exact ctx_search
// call over the stored source by its short id, and the full size. The line counts inside the budget, so a
// replace is never larger than the 18e4a6cd form (selection within REPLACE_RETURN_BYTES + the more line).
test("D-CR3-HANDLE-1: golden handle line: short id, exact call, full size, inside the 18e4a6cd byte bound", async () => {
  const { lintPromptText } = await import("../../../docs/v2/prompt/lint.mjs");
  const { moreLine } = await import("../../../src/core/index/select.ts");
  const text = bigText(40000);
  const p = mainBashPost(text);
  const out = parsed(await handleHook("claude-code", p, env));
  const replaced = replacedText(out.updatedToolOutput);
  const src = query("SELECT id, label, bytes_total FROM sources WHERE session_id = ?", p.session_id);
  assert.equal(src.length, 1);
  const id = "s" + Number(src[0].id).toString(36);
  const nl = replaced.lastIndexOf("\n");
  assert.ok(nl > 0, "a body, then the handle line");
  const intent = p.tool_input.description ?? p.tool_input.command;
  const golden = CCP + "ctx_search({queries:[" + JSON.stringify(intent) + "], source:" + JSON.stringify(id) + "}) searches the whole output (" + Buffer.byteLength(text) + " B).";
  assert.equal(replaced.slice(nl + 1), golden);
  assert.equal(replaced.split("\n" + CCP + "ctx_search(").length, 2, "one call line, no second more line: " + replaced);
  for (const r of lintPromptText(golden)) assert.ok(r.ok, r.rule + " " + JSON.stringify(r.matches));
  const bound = REPLACE_RETURN_BYTES + Buffer.byteLength("\n" + moreLine(intent, src[0].label));
  assert.ok(Buffer.byteLength(replaced) <= bound, Buffer.byteLength(replaced) + " > " + bound);
});

test("D-CR3-HANDLE-1: a subagent replacement carries the same handle line", async () => {
  const text = bigText(40000);
  const p = cc({ hook_event_name: "PostToolUse", tool_name: "Read", agent_id: "a1", agent_type: "general-purpose", tool_input: { file_path: "/tmp/big.log" }, tool_use_id: "toolu_sub", tool_response: text });
  const out = parsed(await handleHook("claude-code", p, env));
  if (out === null || typeof out.updatedToolOutput !== "string") return; // no subagent replace for this shape
  const replaced = out.updatedToolOutput;
  const src = query("SELECT id FROM sources WHERE session_id = ?", p.session_id);
  assert.equal(src.length, 1);
  const last = replaced.slice(replaced.lastIndexOf("\n") + 1);
  assert.ok(last.includes(", source:" + JSON.stringify("s" + Number(src[0].id).toString(36)) + "})"), last);
  assert.ok(last.endsWith("(" + Buffer.byteLength(text) + " B)."), last);
});

// D-CR3-HANDLE-2: above SYNC_INDEX_MAX_BYTES the source row id is reserved before the detached write, so the
// handle is the short id too (not the full label) and the selection budget stays above 0.
test("D-CR3-HANDLE-2: a > SYNC_INDEX_MAX_BYTES output: the handle is the short id of the stored row, the body keeps chunks", async () => {
  const { moreLine } = await import("../../../src/core/index/select.ts");
  const text = bigText(SYNC_INDEX_MAX_BYTES * 2);
  const p = mainBashPost(text);
  const out = parsed(await handleHook("claude-code", p, env));
  const replaced = replacedText(out.updatedToolOutput);
  const src = query("SELECT id, label FROM sources WHERE session_id = ?", p.session_id);
  assert.equal(src.length, 1, "the source row exists when the hook returns");
  const id = "s" + Number(src[0].id).toString(36);
  const nl = replaced.lastIndexOf("\n");
  assert.ok(nl > 0, "a body, then the handle line");
  const intent = p.tool_input.description;
  assert.equal(replaced.slice(nl + 1), CCP + "ctx_search({queries:[" + JSON.stringify(intent) + "], source:" + JSON.stringify(id) + "}) searches the whole output (" + Buffer.byteLength(text) + " B).");
  assert.ok(Buffer.byteLength(replaced.slice(0, nl)) > 0 && replaced.slice(0, nl).includes("needle target"), "the selection budget is not 0");
  const bound = REPLACE_RETURN_BYTES + Buffer.byteLength("\n" + moreLine(intent, src[0].label));
  assert.ok(Buffer.byteLength(replaced) <= bound, Buffer.byteLength(replaced) + " > " + bound);
  const chunks = await waitRows("SELECT ord FROM chunks WHERE source_id = ?", [src[0].id], 1);
  assert.ok(chunks.length > 0, "the detached write stores the chunks under the reserved id");
  const units = await waitRows("SELECT ord FROM line_units WHERE source_id = ?", [src[0].id], 1);
  assert.ok(units.length > 0, "the detached write stores the line units under the reserved id");
});

// D-M2-JSON-1: a JSON output above the sync-index limit has the full label as its handle (a long line). The
// digest budget does not depend on the handle line, so the rare row the prompt names still comes back whole.
test("D-M2-JSON-1: a 200 KB JSON cat returns the rare row whole next to a long handle line", async () => {
  const rows = Array.from({ length: 900 }, (_, i) => ({ id: "ord-" + i, region: "north", amount: i * 3 + 1, priority: i === 411, items: ["a", "b"], note: "some filler words number " + i }));
  const text = JSON.stringify(rows, null, 2);
  assert.ok(Buffer.byteLength(text) > SYNC_INDEX_MAX_BYTES);
  const pr = cc({ hook_event_name: "UserPromptSubmit", prompt: 'Exactly one order has "priority": true. Give three times its "amount".' });
  await handleHook("claude-code", pr, env);
  await waitRows("SELECT 1 FROM events WHERE session_id = ? AND kind = 'prompt'", [pr.session_id], 1);
  const post = { ...mainBashPost(text, ""), session_id: pr.session_id };
  post.tool_input = { command: "cat data/orders.json" };
  const replaced = replacedText(parsed(await handleHook("claude-code", post, env)).updatedToolOutput);
  assert.ok(replaced.includes('"amount":1234,"priority":true'), replaced);
  assert.ok(replaced.split("\n")[0].includes("{id,region,amount,priority,items,note}"), replaced);
  const nl = replaced.lastIndexOf("\n" + CCP + "ctx_search(");
  assert.ok(Buffer.byteLength(replaced.slice(0, nl)) <= 256, "digest within SHAPE_RETURN_BYTES");
});

// D-R4-BUDGET-1: at selection budget 0 the replace is the handle line alone, with no leading newline.
// Through dispatch the budget is never 0 (chunks are at most REPLACE_CHUNK_BYTES, the budget is at least
// REPLACE_RETURN_BYTES - 35), so the join step is tested directly, plus one end-to-end check of the normal join.
test("D-R4-BUDGET-1: replaceOutput with an empty body is the handle line alone, no leading newline", async () => {
  const { replaceOutput } = await import("../../../src/core/hooks/dispatch.ts");
  const line = "ctx_search({queries:[\"q\"], source:\"s1\"}) searches the whole output (9 B).";
  assert.equal(replaceOutput("", line), line);
  assert.equal(replaceOutput("body", line), "body\n" + line);
});

test("D-R4-BUDGET-1: end-to-end a replace never starts with a newline and ends with the handle line after one newline", async () => {
  const out = parsed(await handleHook("claude-code", mainBashPost(bigText(40000), "needle target"), env));
  const replaced = replacedText(out.updatedToolOutput);
  assert.ok(!replaced.startsWith("\n"), JSON.stringify(replaced.slice(0, 40)));
  assert.equal(replaced.split("\n" + CCP + "ctx_search(").length, 2, "body, newline, one handle line");
});

test("D-R4-BUDGET-1: replaceBudget is 0 when the handle line is longer than the more line plus REPLACE_RETURN_BYTES", async () => {
  const { replaceBudget } = await import("../../../src/core/hooks/dispatch.ts");
  const more = "ctx_search({queries:[\"a\"], source:\"l\"})";
  assert.equal(replaceBudget("\n" + "x".repeat(REPLACE_RETURN_BYTES + 500), more), 0);
  assert.ok(replaceBudget("\nshort", more) > 0);
});
