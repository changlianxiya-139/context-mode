// Unit tests for src/adapters/table.ts (impl/10 §1.1-§1.5, §10, §11; DECISIONS-r9 R1, R4, R5; DEVIATIONS D-M3-A7-1,
// D-M5-arch-2, D-M5-A1-1).
// Expected values are copied from the impl/10 tables, not from table.ts. Unit tests may import src/ (TECH-SPEC §6.2a).
import { test } from "node:test";
import assert from "node:assert/strict";

import { ADAPTERS, getAdapter } from "../../../src/adapters/table.ts";
import { AGENT_IDS } from "../../../src/core/contracts/agents.ts";
import * as claudeCode from "../../../src/adapters/claude-code.ts";
import * as codex from "../../../src/adapters/codex.ts";
import * as gemini from "../../../src/adapters/gemini.ts";
import * as qwen from "../../../src/adapters/qwen.ts";
import * as copilotCli from "../../../src/adapters/copilot-cli.ts";
import * as vscode from "../../../src/adapters/vscode.ts";
import * as kiro from "../../../src/adapters/kiro.ts";
import * as zcode from "../../../src/adapters/zcode.ts";
import * as pi from "../../../src/adapters/pi.ts";
import * as opencode from "../../../src/adapters/opencode.ts";

// impl/10 §1.3 main table: installMode, projectSource, toolNamePrefix, compactDelivery, compactSummary, hookTimeoutMs, denyChannel.
// claude-code compactSummary "none": T-CMP arm (a) failed live (DECISIONS-r9 V9, impl/10 §1.3 note, D-M7-CL-1).
const MAIN = {
  "claude-code": ["marketplace", "env:CLAUDE_PROJECT_DIR", "mcp__plugin_context-mode_context-mode__", "sessionstart", "none", 5000, "deny-reason"],
  codex: ["config-mcp", "arg:--agent+cwd", "mcp__context_mode__", "sessionstart", "none", 5000, "deny-reason"],
  gemini: ["extension", "spawn-cwd", "mcp_context-mode_", "pending-flag", "none", 5000, "deny-reason"],
  qwen: ["extension", "spawn-cwd", "mcp__context-mode__", "sessionstart", "none", 5000, "deny-reason"],
  "copilot-cli": ["plugin", "arg:--agent+cwd", "context-mode-", "pending-flag", "none", 5000, "deny-reason"],
  vscode: ["mcp-entry", "arg:workspaceFolder", "mcp_context-mode_", "pending-flag", "none", 5000, "deny-reason"],
  kiro: ["mcp-entry", "arg:--agent+cwd", "mcp_context-mode_", "none", "none", 5000, "hint-only"],
  zcode: ["hooks+mcp", "spawn-cwd", "mcp__context-mode__", "sessionstart", "none", 5000, "deny-reason"],
  pi: ["in-process", "pi:ctx.cwd", "", "pi-flag", "none", 0, "deny-reason"],
  opencode: ["in-process", "spawn-cwd", "", "opencode-cache", "none", 0, "deny-reason"],
};

const CLAUDE_NATIVE = { shell: ["Bash"], read: ["Read"], grep: ["Grep"], webfetch: ["WebFetch"], edit: ["Write", "Edit", "NotebookEdit"] };
// impl/10 §1.3a; zcode = Claude names per DECISIONS-r9 R4 and impl/00 §3.1 (DEVIATIONS D-M3-A7-1).
const NATIVE = {
  "claude-code": CLAUDE_NATIVE,
  codex: { shell: ["Bash"], edit: ["apply_patch"] },
  gemini: { shell: ["run_shell_command"], read: ["read_file"], grep: ["grep_search"], webfetch: ["web_fetch"] }, // gemini-cli 0.65.0 *_TOOL_NAME
  qwen: { shell: ["run_shell_command", "Shell"], read: ["read_file"], grep: ["grep_search"], webfetch: ["web_fetch"] },
  "copilot-cli": { shell: ["bash"] }, // D-HA-COPILOT-NAMES-1
  vscode: { shell: ["run_in_terminal"] }, // D-HF-VSCODE-PROJECT-1
  kiro: { shell: ["execute_bash", "execute_pwsh", "shell"] }, // D-HF-KIRO-SHELL-1, D-N7-KIRO-1
  zcode: CLAUDE_NATIVE,
  pi: { shell: ["bash"], read: ["read"] }, // D-HA-PI-NAMES-1
  opencode: { shell: ["bash"] }, // D-HF-OPENCODE-SHELL-1
};

const CLAUDE_EVENTS = { SessionStart: "SessionStart", UserPromptSubmit: "UserPromptSubmit", PreToolUse: "PreToolUse", PostToolUse: "PostToolUse" };
// impl/10 §1.4; vscode PreCompact per DEVIATIONS D-M3-A4-1.
const EVENTS = {
  "claude-code": CLAUDE_EVENTS,
  codex: CLAUDE_EVENTS,
  gemini: { UserPromptSubmit: "BeforeAgent", PreToolUse: "BeforeTool", PostToolUse: "AfterTool", PreCompact: "PreCompress" },
  qwen: CLAUDE_EVENTS,
  "copilot-cli": { SessionStart: "sessionStart", UserPromptSubmit: "userPromptSubmitted", PreToolUse: "preToolUse", PostToolUse: "postToolUse" },
  vscode: { ...CLAUDE_EVENTS, PreCompact: "PreCompact" },
  kiro: { SessionStart: "SessionStart", UserPromptSubmit: "UserPromptSubmit", PreToolUse: "PreToolUse", PostToolUse: "PostToolUse" },
  zcode: CLAUDE_EVENTS,
  pi: { SessionStart: "session_start", UserPromptSubmit: "input", PreToolUse: "tool_call", PostToolUse: "tool_result" },
  // Usage: OpenCode step-finish cost row (DEVIATIONS D-M5-arch-2).
  opencode: { SessionStart: "context", UserPromptSubmit: "prompt", PreToolUse: "execute.before", PostToolUse: "execute.after", PreCompact: "compaction", Usage: "step-finish" },
};

const MODULES = { "claude-code": claudeCode, codex, gemini, qwen, "copilot-cli": copilotCli, vscode, kiro, zcode, pi, opencode };

test("ADAPTERS has one row per AgentId, in AGENT_IDS order (impl/10 §1.2, §1.3)", () => {
  assert.deepEqual(ADAPTERS.map((r) => r.id), [...AGENT_IDS]);
  assert.ok(Object.isFrozen(ADAPTERS));
  for (const id of AGENT_IDS) assert.equal(getAdapter(id).id, id);
});

test("main columns match impl/10 §1.3", () => {
  for (const id of AGENT_IDS) {
    const r = getAdapter(id);
    assert.deepEqual(
      [r.installMode, r.projectSource, r.toolNamePrefix, r.compactDelivery, r.compactSummary, r.hookTimeoutMs, r.denyChannel],
      MAIN[id],
      id,
    );
  }
});

test("nativeTools match impl/10 §1.3a; execReadOnlyHint true only for codex (DECISIONS-r9 R4, R5)", () => {
  for (const id of AGENT_IDS) {
    const r = getAdapter(id);
    assert.deepEqual(r.nativeTools, NATIVE[id], id);
    assert.equal(r.execReadOnlyHint, id === "codex", id);
  }
});

test("eventMap matches impl/10 §1.4", () => {
  for (const id of AGENT_IDS) assert.deepEqual(getAdapter(id).eventMap, EVENTS[id], id);
});

test("toolNamePrefix equals each adapter module's TOOL_NAME_PREFIX", () => {
  for (const [id, mod] of Object.entries(MODULES)) assert.equal(getAdapter(id).toolNamePrefix, mod.TOOL_NAME_PREFIX, id);
});

test("all 10 adapters are wired to their own decode/encode (no not-built stub)", () => {
  for (const [id, mod] of Object.entries(MODULES)) {
    const r = getAdapter(id);
    assert.equal(r.decode, mod.decode, id + " decode");
    assert.equal(r.encode, mod.encode, id + " encode");
  }
});

test("each newly wired row decodes its own native PreToolUse and encodes allow as empty stdout, exit 0", () => {
  const payloads = {
    gemini: { hook_event_name: "BeforeTool", session_id: "s", cwd: "/p", tool_name: "run_shell_command", tool_input: { command: "ls" } },
    qwen: { hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_name: "run_shell_command", tool_input: { command: "ls" } },
    "copilot-cli": { hookEventName: "preToolUse", sessionId: "s", cwd: "/p", toolName: "bash", toolArgs: { command: "ls" } },
    vscode: { hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_name: "runInTerminal", tool_input: { command: "ls" } },
    kiro: { hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_name: "execute_bash", tool_input: { command: "ls" } },
    zcode: { hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_name: "Bash", tool_input: { command: "ls" } },
  };
  for (const [id, raw] of Object.entries(payloads)) {
    const r = getAdapter(id);
    const ev = r.decode(raw);
    assert.equal(ev.event, "PreToolUse", id);
    assert.equal(ev.agent, id, id);
    assert.deepEqual(r.encode(ev, { kind: "allow" }), { stdout: "", exitCode: 0 }, id);
  }
});

test("pi decodes its call-site payloads (impl/10 §10, DEVIATIONS D-M5-A1-1)", () => {
  const r = getAdapter("pi");
  const pre = r.decode({ type: "tool_call", sessionId: "s", cwd: "/p", toolName: "ctx_execute", toolCallId: "c1", input: { code: "1" } });
  assert.deepEqual(pre, { event: "PreToolUse", agent: "pi", sessionId: "s", cwd: "/p", tool: { name: "ctx_execute", canonicalName: "ctx_execute", input: { code: "1" }, callId: "c1" } });
  assert.equal(r.decode({ type: "session_start", sessionId: "s", cwd: "/p" }).source, "startup");
  assert.equal(r.decode({ type: "session_compact", sessionId: "s", cwd: "/p" }).source, "compact");
  assert.equal(r.decode({ type: "input", sessionId: "s", cwd: "/p", message: "hi" }).prompt, "hi");
  const post = r.decode({ type: "tool_result", sessionId: "s", cwd: "/p", toolName: "bash", input: {}, content: "abc", isError: true });
  assert.deepEqual(post.result, { isError: true, bytes: 3, text: "abc" });
  assert.throws(() => r.decode({ type: "turn_end" }), /pi: unknown hook event turn_end/);
  assert.throws(() => r.decode(null), /pi: hook payload is not an object/);
});

test("pi encode: allow is the empty shape; injected text is a custom-role message with a timestamp", () => {
  const r = getAdapter("pi");
  const ss = { event: "SessionStart", agent: "pi", sessionId: "s", cwd: "/p" };
  const pre = { event: "PreToolUse", agent: "pi", sessionId: "s", cwd: "/p" };
  assert.deepEqual(r.encode(pre, { kind: "allow" }), { stdout: "", exitCode: 0 });
  const hint = r.encode(ss, { kind: "hint", text: "use ctx_resume", onceKey: "k" });
  assert.equal(hint.stdout, "use ctx_resume");
  assert.equal(hint.exitCode, 0);
  assert.equal(hint.role, "custom");
  assert.equal(hint.content, "use ctx_resume");
  assert.ok(Number.isFinite(hint.timestamp));
  assert.equal(r.encode(pre, { kind: "hint", text: "x", onceKey: "k" }).stdout, "", "no tool_call hint field: dropped");
  const deny = r.encode(pre, { kind: "deny", reason: "use ctx_execute", rewritten: "node run.mjs x" });
  assert.equal(deny.exitCode, 2);
  assert.equal(deny.stdout, "node run.mjs x\nuse ctx_execute");
  assert.deepEqual(pi.checkPermission(deny), { block: true, reason: "node run.mjs x\nuse ctx_execute" });
  assert.equal(pi.checkPermission({ stdout: "", exitCode: 0 }), undefined);
  assert.equal(r.encode({ ...pre, event: "PostToolUse" }, { kind: "replace", output: "short" }).stdout, "short");
});

test("opencode decodes its call-site payloads, webfetch is WebFetch, step-finish is Usage (impl/10 §11, D-M5-arch-2)", () => {
  const r = getAdapter("opencode");
  const pre = r.decode({ type: "execute.before", sessionID: "s", directory: "/p", tool: "webfetch", callID: "c1", args: { url: "https://x.test" } });
  assert.deepEqual(pre, { event: "PreToolUse", agent: "opencode", sessionId: "s", cwd: "/p", tool: { name: "webfetch", canonicalName: "WebFetch", input: { url: "https://x.test" }, callId: "c1" } });
  assert.equal(r.decode({ type: "execute.before", sessionID: "s", directory: "/p", tool: "context-mode_ctx_execute", args: {} }).tool.canonicalName, "ctx_execute");
  assert.equal(r.decode({ type: "execute.before", sessionID: "s", directory: "/p", tool: "bash", args: {} }).tool.canonicalName, "Bash"); // D-HF-OPENCODE-SHELL-1
  assert.equal(r.toCanonicalTool("webfetch"), "WebFetch");
  assert.equal(r.decode({ type: "context", sessionID: "s", directory: "/p" }).event, "SessionStart");
  assert.equal(r.decode({ type: "compaction", sessionID: "s", directory: "/p" }).event, "PreCompact");
  assert.equal(r.decode({ type: "prompt", sessionID: "s", directory: "/p", message: "hi" }).prompt, "hi");
  const usage = r.decode({ type: "step-finish", sessionID: "s", directory: "/p", turn: 3 });
  assert.deepEqual(usage, { event: "Usage", agent: "opencode", sessionId: "s", cwd: "/p", turn: 3 });
  const post = r.decode({ type: "execute.after", sessionID: "s", directory: "/p", tool: "bash", args: {}, output: "abc" });
  assert.deepEqual(post.result, { isError: false, bytes: 3, text: "abc" });
  assert.throws(() => r.decode({ type: "message.updated" }), /opencode: unknown hook event message.updated/);
});

test("opencode encode: hint only on session text, deny exits 2 on execute.before only, prompt never fails", () => {
  const r = getAdapter("opencode");
  const base = { agent: "opencode", sessionId: "s", cwd: "/p" };
  assert.deepEqual(r.encode({ ...base, event: "PreToolUse" }, { kind: "allow" }), { stdout: "", exitCode: 0 });
  assert.deepEqual(r.encode({ ...base, event: "SessionStart" }, { kind: "hint", text: "t", onceKey: "k" }), { stdout: "t", exitCode: 0 });
  assert.deepEqual(r.encode({ ...base, event: "PreToolUse" }, { kind: "hint", text: "t", onceKey: "k" }), { stdout: "", exitCode: 0 });
  assert.deepEqual(r.encode({ ...base, event: "PreToolUse" }, { kind: "deny", reason: "why" }), { stdout: "why", exitCode: 2 });
  assert.deepEqual(r.encode({ ...base, event: "UserPromptSubmit" }, { kind: "deny", reason: "why" }), { stdout: "", exitCode: 0 });
  assert.deepEqual(r.encode({ ...base, event: "PostToolUse" }, { kind: "replace", output: "o" }), { stdout: "", exitCode: 0 });
});

// D-FU-RM-KIRO-2: every native name a row's eventMap emits (the build writes these into hooks/<id>.json) must
// decode to its canonical event, or the host fires a hook the entry drops ("unknown hook event").
test("each spawn row decodes every native event name its eventMap emits", () => {
  for (const row of ADAPTERS.filter((r) => r.installMode !== "in-process")) {
    for (const [canonical, native] of Object.entries(row.eventMap)) {
      const payload = { hook_event_name: native, session_id: "s", cwd: "/tmp/p", tool_name: "x", tool_input: {}, tool_response: "" };
      assert.equal(row.decode(payload).event, canonical, `${row.id}: ${native}`);
    }
  }
});

// ADR-0020: every row names its one hook channel and its one skill channel. Expected values copied from the ADR table.
const HOOK_CHANNEL = {
  "claude-code": { kind: "package", path: "hooks/claude-code.json" },
  codex: { kind: "home-file", path: ".codex/hooks.json" },
  gemini: { kind: "package", path: "hooks/hooks.json" },
  qwen: { kind: "package", path: "hooks/qwen.json" },
  "copilot-cli": { kind: "home-file", path: ".copilot/hooks/context-mode.json" },
  vscode: { kind: "home-file", path: ".copilot/hooks/context-mode-vscode.json" },
  kiro: { kind: "home-file", path: ".kiro/hooks/context-mode.json" },
  zcode: { kind: "home-file", path: ".zcode/cli/config.json" },
  pi: { kind: "in-process", path: "pi/index.js" },
  opencode: { kind: "in-process", path: "opencode/plugin.js" },
};
const SKILL_CHANNEL = {
  "claude-code": { kind: "package", path: "claude-code/skills" }, // D-HQ-SKILLS-2
  codex: { kind: "home-dir", path: ".codex/skills" },
  gemini: { kind: "package", path: "skills" },
  qwen: { kind: "package", path: "skills" }, // D-HQ-SKILLS-3: <extension>/skills, shared with gemini
  "copilot-cli": { kind: "home-dir", path: ".copilot/skills" },
  vscode: { kind: "home-dir", path: ".agents/skills" }, // D-HQ-COPILOT-NAMES-3
  kiro: { kind: "home-dir", path: ".kiro/skills" },
  zcode: { kind: "home-dir", path: ".zcode/skills" },
  pi: { kind: "package", path: "pi/skills" },
  opencode: { kind: "home-dir", path: ".config/opencode/skills" },
};

test("every row has a hookChannel and a skillChannel with a non-empty path (ADR-0020, no exception rows)", () => {
  for (const id of AGENT_IDS) {
    const r = getAdapter(id);
    assert.ok(r.hookChannel && typeof r.hookChannel.path === "string" && r.hookChannel.path.length > 0, id + " hookChannel");
    assert.ok(r.skillChannel && typeof r.skillChannel.path === "string" && r.skillChannel.path.length > 0, id + " skillChannel");
    assert.deepEqual(r.hookChannel, HOOK_CHANNEL[id], id + " hookChannel");
    assert.deepEqual(r.skillChannel, SKILL_CHANNEL[id], id + " skillChannel");
  }
});
