// tests/v2/setup/zcode-shape.test.mjs
// OPEN-ITEMS H2 (D-HF-ZCODE-SHAPE-1). ZCode CLI docs: hooks live in ~/.zcode/cli/config.json as
// hooks.events.<Event>[] matcher groups {matcher?, hooks:[{type, command, timeoutMs}]}
// (zcode.z.ai/en/docs/hooks; github.com/zai-org/ZCode apps/zcode-cli/docs/usage/09-hooks.md), and MCP servers as
// mcp.servers.<name> {type:"stdio", command, args, enabled, timeoutMs} with features.mcp true
// (apps/zcode-cli/docs/usage/07-mcp.md: "先确保 features.mcp 已启用"; zcode.z.ai/en/docs/mcp-services, ZCode 3.16.3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getAdapter } from "../../../src/adapters/table.ts";
import { EXEC_TIMEOUT_MS, TOOL_ORDER } from "../../../src/core/contracts/constants.ts";
import { composeMatcher } from "../../../src/core/ops/doctor-config.ts";
import { generateManifests } from "../../../build/manifests.ts";
import { runDoctor, runSetup } from "../../../src/setup/index.ts";

const NODE = process.execPath;
const REPO = path.resolve(import.meta.dirname, "../../..");

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "cm-zcode-shape-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const pkgDir = path.join(root, "pkg");
  mkdirSync(home, { recursive: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "server.mjs"), `
import { createInterface } from "node:readline";
const tools = ${JSON.stringify([...TOOL_ORDER])};
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  const result = m.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "context-mode", version: "2.0.0" } }
    : { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
`);
  writeFileSync(path.join(pkgDir, "hook.mjs"), `let s = ""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => { const p = JSON.parse(s); if (!JSON.stringify(p).includes("context-mode-doctor-hook-runs")) return; const t = "deny: run ctx_execute; ctx_search( finds the rest"; process.stderr.write(t + "\\n"); process.stdout.write(JSON.stringify({ decision: "deny", reason: t })); });\n`);
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "context-mode", version: "2.0.0" }));
  generateManifests(pkgDir);
  for (const k of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) cpSync(path.join(REPO, "skills", k), path.join(pkgDir, "skills", k), { recursive: true });
  for (const k of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) cpSync(path.join(REPO, "skills", k), path.join(pkgDir, "pi", "skills", k), { recursive: true }); // D-HQ-SKILLS-1
  for (const k of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) cpSync(path.join(REPO, "skills", k), path.join(pkgDir, "claude-code", "skills", k), { recursive: true }); // D-HQ-SKILLS-2
  return { home, pkgDir, env: { PATH: "/usr/bin:/bin", HOME: home, USERPROFILE: home, CM_HOOK_OVERHEAD_BUDGET_MS: "60000" } };
}

const cfg = (home) => JSON.parse(readFileSync(path.join(home, ".zcode", "cli", "config.json"), "utf8"));

test("H2: setup writes zcode hooks as matcher groups and MCP under mcp.servers with features.mcp true", async (t) => {
  const s = sandbox(t);
  const res = await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["zcode"], runId: "z" });
  const doc = cfg(s.home);
  const cmd = `"${NODE}" "${path.join(s.pkgDir, "hook.mjs")}" --agent zcode`;
  assert.equal(doc.hooks.enabled, true);
  const row = getAdapter("zcode");
  assert.deepEqual(doc.hooks.events.PreToolUse, [{ matcher: composeMatcher(row, "PreToolUse"), hooks: [{ type: "command", command: cmd, timeoutMs: row.hookTimeoutMs }] }]);
  assert.deepEqual(doc.hooks.events.SessionStart, [{ hooks: [{ type: "command", command: cmd, timeoutMs: row.hookTimeoutMs }] }]);
  assert.equal(doc.mcpServers, undefined, "no top-level mcpServers");
  assert.deepEqual(doc.mcp.servers["context-mode"], {
    type: "stdio", command: NODE, args: [path.join(s.pkgDir, "server.mjs"), "--agent", "zcode"], enabled: true, timeoutMs: EXEC_TIMEOUT_MS,
  });
  assert.equal(doc.features.mcp, true);
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
});

test("H2: the release hooks/zcode.json uses matcher groups", (t) => {
  const s = sandbox(t);
  const z = JSON.parse(readFileSync(path.join(s.pkgDir, "hooks", "zcode.json"), "utf8"));
  for (const groups of Object.values(z.hooks.events)) {
    for (const g of groups) {
      assert.ok(Array.isArray(g.hooks) && g.hooks.length === 1, JSON.stringify(g));
      assert.equal(g.hooks[0].type, "command");
      assert.equal(typeof g.hooks[0].timeoutMs, "number");
      assert.equal("command" in g, false, "no bare handler at group level");
    }
  }
});

test("H2: doctor hook-registered FAILs on the old bare-handler zcode shape", async (t) => {
  const s = sandbox(t);
  await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["zcode"], runId: "z" });
  const file = path.join(s.home, ".zcode", "cli", "config.json");
  const doc = cfg(s.home);
  for (const [ev, groups] of Object.entries(doc.hooks.events)) {
    doc.hooks.events[ev] = groups.map((g) => ({ ...g.hooks[0], ...(g.matcher ? { matcher: g.matcher } : {}) }));
  }
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const d = await runDoctor({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["zcode"] });
  assert.equal(d.agents[0].status, "FAIL", JSON.stringify(d.agents[0]));
});

test("H2: doctor FAILs when features.mcp is off", async (t) => {
  const s = sandbox(t);
  await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["zcode"], runId: "z" });
  const file = path.join(s.home, ".zcode", "cli", "config.json");
  const doc = cfg(s.home);
  doc.features = { mcp: false };
  writeFileSync(file, JSON.stringify(doc, null, 2));
  const d = await runDoctor({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["zcode"] });
  assert.equal(d.agents[0].status, "FAIL", JSON.stringify(d.agents[0]));
});

test("H2: uninstall drops only mcp.servers.context-mode and keeps the user's other zcode servers", async (t) => {
  const { runUninstall } = await import("../../../src/core/ops/uninstall.ts");
  const root = mkdtempSync(path.join(tmpdir(), "cm-zcode-un-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ".zcode", "cli", "config.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const other = { type: "stdio", command: "o", args: [], enabled: true };
  writeFileSync(file, JSON.stringify({ features: { mcp: true }, mcp: { servers: { other, "context-mode": { type: "stdio", command: "node", args: ["/p/server.mjs"] } } } }, null, 2));
  runUninstall({ adapter: { id: "zcode", installMode: "hooks+mcp" }, project: { projectKey: "abcdef0123456789" }, env: { HOME: root, USERPROFILE: root }, confirmDelete: false });
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc.mcp.servers, { other });
  assert.equal(doc.features.mcp, true, "user feature flag kept");
});

// Z-WIN-1: Notepad and PowerShell 5 (Set-Content -Encoding UTF8) write ~/.zcode/cli/config.json with a BOM and CRLF.
// Setup edits it, doctor parses it, remove gives the bytes back. Runs on every OS: the bytes are built in the test.
test("Z-WIN-1: zcode setup, doctor and remove read a BOM + CRLF config.json and keep its layout", async (t) => {
  const { runRemove } = await import("../../../src/setup/index.ts");
  const BOM = "﻿";
  const s = sandbox(t);
  const file = path.join(s.home, ".zcode", "cli", "config.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const other = { type: "stdio", command: "o", args: [], enabled: true };
  const user = BOM + JSON.stringify({ theme: "dark", mcp: { servers: { other } } }, null, 2).split("\n").join("\r\n") + "\r\n";
  writeFileSync(file, user);
  const res = await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["zcode"], runId: "z" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
  const after = readFileSync(file, "utf8");
  assert.ok(after.startsWith(BOM) && !after.slice(1).includes(BOM), "one BOM kept");
  assert.ok(!after.split("\r\n").join("").includes("\n"), "CRLF kept");
  const doc = JSON.parse(after.slice(1));
  assert.equal(doc.theme, "dark", "user key kept");
  assert.deepEqual(doc.mcp.servers.other, other, "user server kept");
  assert.ok(doc.mcp.servers["context-mode"], "our server added");
  assert.equal(doc.hooks.enabled, true);
  const d = await runDoctor({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["zcode"] });
  assert.equal(d.agents[0].status, "PASS", JSON.stringify(d.agents[0]));
  assert.equal(d.agents[0].checks.find((c) => c.name === "parse")?.ok, true, "doctor parses the BOM file");
  assert.equal(runRemove({ home: s.home, env: s.env }).exitCode, 0);
  assert.equal(readFileSync(file, "utf8"), user, "remove restores the original bytes");
});
