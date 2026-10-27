// tests/v2/hooks/vscode-tools.test.mjs
// D-N7-VSCODE-TOOLS-1. Tool names a VS Code agent-mode hook payload carries, one list for decoder and table.
// Local harness (hook_event_name PreToolUse, snake_case): tool_name is the internal tool id.
//   microsoft/vscode 1.145.0 (90ff6fb, 2026-10-27) src/vs/workbench/contrib/chat/common/tools/terminalToolIds.ts:
//     TerminalToolId.RunInTerminal = 'run_in_terminal'.
//   microsoft/vscode-copilot-chat 0.44.0 (5863f5a) src/extension/tools/common/toolNames.ts: ToolName.ReadFile =
//     'read_file' (input filePath, startLine, endLine: package.json copilot_readFile), FetchWebPage = 'fetch_webpage'
//     (input urls[], query), CoreRunInTerminal = 'run_in_terminal'; src/extension/chat/vscode-node/chatHookService.ts
//     executePreToolUseHook sends {tool_name: toolName, tool_input, tool_use_id} with the toolCall name from
//     src/extension/prompts/node/panel/toolCalling.tsx.
// Copilot harness (event names the hooks file registers, runs in the Copilot runtime):
//   docs.github.com copilot/reference/hooks-reference ("Tool names for hook matching", "Claude-format matchers"):
//   camelCase toolName is bash, powershell, view, web_fetch; PascalCase PreToolUse reports the Claude name
//   (Bash, Read, WebFetch), which is already the canonical name.
// "runTerminalCommand" is in none of these sources (vscode, vscode-copilot-chat, vscode-docs, github/docs). It is
// mapped because the next.7 npm-package test received it live (toolName runTerminalCommand, "cat logs/app.log").
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleHook } from "../../../src/core/hooks/dispatch.ts";
import { decode } from "../../../src/adapters/vscode.ts";
import { getAdapter } from "../../../src/adapters/table.ts";
import { generateManifests } from "../../../build/manifests.ts";

let root, repo, oldHome;
before(() => {
  root = mkdtempSync(path.join(tmpdir(), "cm-vscode-tools-"));
  repo = path.join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  mkdirSync(path.join(repo, "logs"));
  writeFileSync(path.join(repo, "logs", "app.log"), "x".repeat(200_000));
  oldHome = process.env.HOME;
  process.env.HOME = root; process.env.USERPROFILE = root;
});
after(() => { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

const SHELL = ["run_in_terminal", "runTerminalCommand", "bash", "powershell"]; // runTerminalCommand: seen live in the next.7 npm-package test, in no source
const READ = ["read_file", "view"];
const FETCH = ["fetch_webpage", "web_fetch"];

test("the vscode row lists every documented shell, read and fetch tool name", () => {
  const n = getAdapter("vscode").nativeTools;
  assert.deepEqual(n.shell, SHELL);
  assert.deepEqual(n.read, READ);
  assert.deepEqual(n.webfetch, FETCH);
});

test("decode maps each name to its canonical tool, snake_case and camelCase", () => {
  const canon = { run_in_terminal: "Bash", runTerminalCommand: "Bash", bash: "Bash", powershell: "Bash", read_file: "Read", view: "Read", fetch_webpage: "WebFetch", web_fetch: "WebFetch" };
  for (const [name, want] of Object.entries(canon)) {
    const snake = decode({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_name: name, tool_input: {} });
    assert.equal(snake.tool.canonicalName, want, "snake " + name);
    const camel = decode({ hookEventName: "preToolUse", sessionId: "s", cwd: "/p", toolName: name, toolArgs: {} });
    assert.equal(camel.tool.canonicalName, want, "camel " + name);
  }
  for (const name of ["Bash", "Read", "WebFetch"]) { // Claude names from a PascalCase Copilot payload
    assert.equal(decode({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_name: name, tool_input: {} }).tool.canonicalName, name);
  }
});

test("decode reads each tool's documented input keys", () => {
  const d = (tool_name, tool_input) => decode({ hook_event_name: "PreToolUse", session_id: "s", cwd: "/p", tool_name, tool_input }).tool.input;
  assert.deepEqual(d("read_file", { filePath: "/a/b.log", startLine: 5, endLine: 20 }), { filePath: "/a/b.log", startLine: 5, endLine: 20, file_path: "/a/b.log", offset: 5, limit: 16 });
  assert.deepEqual(d("view", { path: "/a/b.log", view_range: [3, 9] }), { path: "/a/b.log", view_range: [3, 9], offset: 3, limit: 7 });
  assert.deepEqual(d("view", { path: "/a/b.log" }), { path: "/a/b.log" });
  assert.deepEqual(d("fetch_webpage", { urls: ["https://example.com/a", "https://example.com/b"], query: "q" }), { urls: ["https://example.com/a", "https://example.com/b"], query: "q", url: "https://example.com/a" });
  assert.deepEqual(d("web_fetch", { url: "https://example.com/a" }), { url: "https://example.com/a" });
});

const env = () => ({ HOME: root, PATH: process.env.PATH });
const snake = (tool_name, tool_input) => ({ hook_event_name: "PreToolUse", session_id: "s-st", cwd: repo, timestamp: "2026-10-27T00:00:00Z", tool_name, tool_input });
const camel = (toolName, toolArgs) => ({ hookEventName: "preToolUse", sessionId: "s-ct", cwd: repo, timestamp: 1790000000000, toolName, toolArgs });
const denied = (out) => {
  assert.equal(out.exitCode, 0);
  assert.notEqual(out.stdout, "", "hook gave no output");
  return JSON.parse(out.stdout).hookSpecificOutput;
};

for (const name of SHELL) {
  for (const [form, make] of [["snake_case", snake], ["camelCase", camel]]) {
    test(`${form} ${name}: a 200 KB cat is denied with ctx_execute`, async () => {
      const h = denied(await handleHook("vscode", make(name, { command: "cat logs/app.log" }), env()));
      assert.equal(h.permissionDecision, "deny");
      assert.ok(h.permissionDecisionReason.includes("ctx_execute"), h.permissionDecisionReason);
    });
    test(`${form} ${name}: curl is denied`, async () => {
      const h = denied(await handleHook("vscode", make(name, { command: "curl https://example.org/data.json" }), env()));
      assert.equal(h.permissionDecision, "deny");
    });
  }
}

test("Claude-named PascalCase payloads (Copilot harness) deny a 200 KB cat and curl", async () => {
  assert.equal(denied(await handleHook("vscode", snake("Bash", { command: "cat logs/app.log" }), env())).permissionDecision, "deny");
  assert.equal(denied(await handleHook("vscode", snake("Bash", { command: "curl https://example.org/x" }), env())).permissionDecision, "deny");
});

for (const [form, make] of [["snake_case", snake], ["camelCase", camel]]) {
  test(`${form}: fetch_webpage and web_fetch are denied like WebFetch`, async () => {
    for (const [name, input] of [["fetch_webpage", { urls: ["https://example.org/page"], query: "q" }], ["web_fetch", { url: "https://example.org/page" }]]) {
      const h = denied(await handleHook("vscode", make(name, input), env()));
      assert.equal(h.permissionDecision, "deny", name);
      assert.ok(h.permissionDecisionReason.includes("https://example.org/page"), h.permissionDecisionReason);
    }
  });
  test(`${form}: view of a 200 KB file is denied, a ranged read_file and view are allowed`, async () => {
    const file = path.join(repo, "logs", "app.log");
    assert.equal(denied(await handleHook("vscode", make("view", { path: file }), env())).permissionDecision, "deny");
    assert.deepEqual(await handleHook("vscode", make("view", { path: file, view_range: [1, 20] }), env()), { stdout: "", exitCode: 0 });
    assert.deepEqual(await handleHook("vscode", make("read_file", { filePath: file, startLine: 1, endLine: 20 }), env()), { stdout: "", exitCode: 0 });
  });
}

test("the vscode hook file registers no matcher, so every tool name reaches the hook", () => {
  const dir = path.join(root, "pkg");
  mkdirSync(dir, { recursive: true });
  generateManifests(dir);
  const f = JSON.parse(readFileSync(path.join(dir, "hooks", "vscode.json"), "utf8"));
  for (const native of ["PreToolUse", "PostToolUse"]) {
    assert.equal(f.hooks[native].length, 1, native);
    assert.equal("matcher" in f.hooks[native][0], false, native);
  }
});
