// tests/v2/hooks/vscode-project.test.mjs
// OPEN-ITEMS H1 (D-HF-VSCODE-PROJECT-1). VS Code: the MCP server gets the workspace folder as
// `--workspace-folder ${workspaceFolder}` (VS Code MCP configuration reference: predefined variables such as
// ${workspaceFolder} in the server config); a hook gets it from the payload `cwd` (VS Code hooks reference,
// "Common input": cwd). The VS Code terminal tool is `run_in_terminal`, so a shell dump there reaches the shell rule.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleHook } from "../../../src/core/hooks/dispatch.ts";
import { getAdapter } from "../../../src/adapters/table.ts";
import { buildRegistry } from "../../../src/setup/index.ts";

let root, repo, oldHome;
before(() => {
  root = mkdtempSync(path.join(tmpdir(), "cm-vscode-proj-"));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, "big.log"), "x".repeat(200_000));
  oldHome = process.env.HOME;
  process.env.HOME = root;
});
after(() => { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

test("H1: setup writes the VS Code MCP args with --workspace-folder ${workspaceFolder}", () => {
  const row = buildRegistry({ home: "/h", pkgDir: "/abs/pkg", env: {} }).find((r) => r.id === "vscode");
  assert.deepEqual(row.config.value.args, [path.join("/abs/pkg", "server.mjs"), "--agent", "vscode", "--workspace-folder", "${workspaceFolder}"]);
});

test("H1: the VS Code shell tools are run_in_terminal, runTerminalCommand, bash, powershell (D-N7-VSCODE-TOOLS-1)", () => {
  assert.deepEqual(getAdapter("vscode").nativeTools.shell, ["run_in_terminal", "runTerminalCommand", "bash", "powershell"]);
});

test("H1: a VS Code hook run from a project resolves it from the payload cwd and denies a large shell read", async () => {
  const env = { HOME: root, PATH: process.env.PATH };
  const out = await handleHook("vscode", {
    hook_event_name: "PreToolUse", session_id: "s-vscode", cwd: repo, timestamp: "2026-10-26T00:00:00Z",
    tool_name: "run_in_terminal", tool_input: { command: "cat big.log" },
  }, env);
  assert.equal(out.exitCode, 0);
  const h = JSON.parse(out.stdout).hookSpecificOutput;
  assert.equal(h.permissionDecision, "deny");
  assert.ok(h.permissionDecisionReason.includes("ctx_execute"), h.permissionDecisionReason);
  assert.ok(h.permissionDecisionReason.includes(path.join(repo, "big.log")) || h.permissionDecisionReason.includes("big.log"), h.permissionDecisionReason);
});

// D-HF-VSCODE-DECODE-1: the camelCase payload with hookEventName that next.6 rejected now reaches the shell rule.
test("D-HF-VSCODE-DECODE-1: a camelCase hook payload (hookEventName) denies a large shell read like the snake_case one", async () => {
  const env = { HOME: root, PATH: process.env.PATH };
  const out = await handleHook("vscode", {
    hookEventName: "preToolUse", sessionId: "s-vscode-camel", cwd: repo, timestamp: 1790000000000,
    toolName: "run_in_terminal", toolArgs: { command: "cat big.log" },
  }, env);
  assert.equal(out.exitCode, 0);
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("D-HF-VSCODE-DECODE-1: a payload with no readable event is not silent: allow shape and one decode-failed stderr line", async () => {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c) => { lines.push(String(c)); return true; };
  let out;
  try { out = await handleHook("vscode", { sessionId: "x", cwd: repo }, { HOME: root, PATH: process.env.PATH }); } finally { process.stderr.write = orig; }
  assert.deepEqual(out, { stdout: "", exitCode: 0 });
  assert.equal(lines.length, 1, lines.join("|"));
  assert.ok(lines[0].startsWith("hooks: decode failed: vscode: missing required field hook_event_name"), lines[0]);
});
