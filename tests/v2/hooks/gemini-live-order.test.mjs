// tests/v2/hooks/gemini-live-order.test.mjs
// Spec: ADR-0020 decision 4. Gemini CLI 0.65.0 bundle: fireBeforeAgentEvent(partToString(request)) runs before
// the first model call of a turn, and AfterTool gets {llmContent, returnDisplay, error}. hooks-fast round 1 piped
// AfterTool alone (no BeforeAgent), so no prompt was stored and the rare FATAL line was not in the replace.
// This pins the live order: BeforeAgent (prompt) then AfterTool `cat big.log` -> the deny reason holds the line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleHook } from "../../../src/core/hooks/dispatch.ts";

function rmTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
}

const FATAL = "FATAL: disk controller failure code=E-7731";

test("gemini BeforeAgent prompt then AfterTool run_shell_command cat: the deny reason holds the FATAL line", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "cm-gem-live-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root; process.env.USERPROFILE = root;
  t.after(() => { process.env.HOME = oldHome; rmTemp(root); });
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const lines = [];
  for (let i = 0; i < 4000; i++) lines.push(i === 3001 ? FATAL : "INFO line " + i + " request ok");
  const big = lines.join("\n") + "\n";
  writeFileSync(path.join(repo, "big.log"), big);
  const env = { HOME: root, USERPROFILE: root, PATH: process.env.PATH };
  const base = { session_id: "g-live", transcript_path: "", cwd: repo, timestamp: "2026-10-26T00:00:00Z" };

  const ba = await handleHook("gemini", { ...base, hook_event_name: "BeforeAgent", prompt: "What is the FATAL error in big.log?" }, env);
  assert.equal(ba.exitCode, 0);

  const at = await handleHook("gemini", { ...base, hook_event_name: "AfterTool", tool_name: "run_shell_command",
    tool_input: { command: "cat big.log" }, tool_response: { llmContent: big, returnDisplay: big } }, env);
  assert.equal(at.exitCode, 0);
  const j = JSON.parse(at.stdout);
  assert.equal(j.decision, "deny");
  assert.ok(j.reason.includes(FATAL), j.reason);
  assert.ok(Buffer.byteLength(j.reason) < Buffer.byteLength(big) / 100, String(Buffer.byteLength(j.reason)));
});
