// tests/v2/hooks/tool-names.test.mjs
// Hook texts name tools the way the host calls them: row.toolNamePrefix + ctx_*. A bare ctx_search on Gemini
// (mcp_context-mode_ctx_search) names a tool the model cannot call. Covers the 10 hosts and every hook text
// that names a tool: Read deny, parse-error deny, policy-unreadable deny, the replace handle line, the
// compact state block and the pointer line. DEVIATIONS D-HL-NAMES-1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleHook } from "../../../src/core/hooks/dispatch.ts";
import { decide } from "../../../src/core/policy/decide.ts";
import { ADAPTERS } from "../../../src/adapters/table.ts";
import { renderState } from "../../../src/core/compaction/render.ts";
import {
  PARSE_ERROR_DENY_LINE, POLICY_UNREADABLE_LINE, REPLACE_HANDLE_LINE, REQUIRE_SECURITY_ENV, TOOL_ORDER, prefixToolNames,
} from "../../../src/core/contracts/constants.ts";
import { READ_DENY_MESSAGE } from "../../../src/core/policy/read-deny.ts";

function rmTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
}

// Every ctx_* name in the text carries the prefix (an empty prefix leaves the text as is).
function allPrefixed(text, prefix) {
  for (const name of TOOL_ORDER) {
    const parts = text.split(name);
    for (let i = 0; i < parts.length - 1; i++) {
      if (!parts[i].endsWith(prefix)) return false;
    }
  }
  return true;
}

const ev = (row, cwd, name, canonicalName, input) => ({
  event: "PreToolUse", agent: row.id, sessionId: "s1", cwd, tool: { name, canonicalName, input },
});

test("all 10 hosts: the Read deny names <prefix>ctx_execute", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cm-names-"));
  try {
    const big = path.join(dir, "big.log");
    writeFileSync(big, "x".repeat(300 * 1024));
    assert.equal(ADAPTERS.length, 10);
    for (const row of ADAPTERS) {
      const d = decide(ev(row, dir, "Read", "Read", { file_path: big }), row, []);
      assert.equal(d.kind, "deny", row.id);
      assert.equal(d.reason, READ_DENY_MESSAGE(big, 300 * 1024, row.toolNamePrefix), row.id);
      assert.ok(d.reason.includes(row.toolNamePrefix + "ctx_execute("), row.id + ": " + d.reason);
      assert.ok(allPrefixed(d.reason, row.toolNamePrefix), row.id + ": " + d.reason);
    }
  } finally {
    rmTemp(dir);
  }
});

test("all 10 hosts: parse-error and policy-unreadable denies name <prefix>ctx_*", () => {
  const old = process.env[REQUIRE_SECURITY_ENV];
  try {
    for (const row of ADAPTERS) {
      const parse = decide(ev(row, "/", "Bash", "Bash", { command: 'ls; rm -rf / "x' }), row, ["Bash(rm -rf:*)"]);
      assert.deepEqual(parse, { kind: "deny", reason: prefixToolNames(PARSE_ERROR_DENY_LINE, row.toolNamePrefix) }, row.id);
      assert.ok(parse.reason.includes(row.toolNamePrefix + "ctx_execute"), row.id + ": " + parse.reason);
      assert.ok(allPrefixed(parse.reason, row.toolNamePrefix), row.id + ": " + parse.reason);
      process.env[REQUIRE_SECURITY_ENV] = "1";
      const unread = decide(ev(row, "/", "Bash", "Bash", { command: "ls" }), row, null);
      delete process.env[REQUIRE_SECURITY_ENV];
      assert.deepEqual(unread, { kind: "deny", reason: prefixToolNames(POLICY_UNREADABLE_LINE, row.toolNamePrefix) }, row.id);
      assert.ok(unread.reason.includes(row.toolNamePrefix + "ctx_doctor"), row.id + ": " + unread.reason);
    }
  } finally {
    if (old === undefined) delete process.env[REQUIRE_SECURITY_ENV];
    else process.env[REQUIRE_SECURITY_ENV] = old;
  }
});

test("REPLACE_HANDLE_LINE and renderState take the host prefix; the intent is never rewritten", () => {
  const p = "mcp_context-mode_";
  const line = REPLACE_HANDLE_LINE("grep ctx_search notes", "s1", 9, p);
  assert.equal(line, p + 'ctx_search({queries:["grep ctx_search notes"], source:"s1"}) searches the whole output (9 B).');
  assert.equal(REPLACE_HANDLE_LINE("q", "s1", 9), 'ctx_search({queries:["q"], source:"s1"}) searches the whole output (9 B).');
  const rows = [{
    seq: 1, session_id: "s1", worktree: "/w", agent: "gemini", kind: "prompt", tool: null, key: null, path: null, ok: 1,
    exit_code: null, bytes: 0, body: "fix the login test", turn: 1, sandbox_bytes: 0, returned_bytes: 0, created_at: 0, accessed_at: 0,
  }];
  const block = renderState(rows, 1, undefined, p);
  assert.ok(block.includes("more: " + p + "ctx_search("), block);
  assert.ok(allPrefixed(block, p), block);
});

test("gemini AfterTool `cat big.log`: the deny reason names mcp_context-mode_ctx_search", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "cm-names-gem-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root; process.env.USERPROFILE = root;
  t.after(() => { process.env.HOME = oldHome; rmTemp(root); });
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const lines = [];
  for (let i = 0; i < 4000; i++) lines.push("INFO line " + i + " request ok");
  const big = lines.join("\n") + "\n";
  const env = { HOME: root, PATH: process.env.PATH };
  const base = { session_id: "g-names", transcript_path: "", cwd: repo, timestamp: "2026-10-26T00:00:00Z" };
  const at = await handleHook("gemini", { ...base, hook_event_name: "AfterTool", tool_name: "run_shell_command",
    tool_input: { command: "cat big.log" }, tool_response: { llmContent: big, returnDisplay: big } }, env);
  const j = JSON.parse(at.stdout);
  assert.equal(j.decision, "deny");
  assert.ok(j.reason.includes("mcp_context-mode_ctx_search({queries:"), j.reason.slice(-300));
  assert.ok(allPrefixed(j.reason, "mcp_context-mode_"), j.reason.slice(-300));
});
