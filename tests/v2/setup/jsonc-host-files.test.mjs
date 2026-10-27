// tests/v2/setup/jsonc-host-files.test.mjs
// VS-WIN-5 (D-WIN-JSONC-1). VS Code reads .vscode/mcp.json and OpenCode reads opencode.json as JSONC (comments,
// trailing commas), so setup and doctor must accept such a file and keep the user's comments byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TOOL_ORDER } from "../../../src/core/contracts/constants.ts";
import { generateManifests } from "../../../build/manifests.ts";
import { runDoctor, runSetup } from "../../../src/setup/index.ts";

const REPO = path.resolve(import.meta.dirname, "../../..");

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "cm-jsonc-"));
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
  for (const sub of ["skills", "pi/skills", "claude-code/skills"]) for (const k of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) cpSync(path.join(REPO, "skills", k), path.join(pkgDir, sub, k), { recursive: true });
  return { home, pkgDir, env: { PATH: "/usr/bin:/bin", HOME: home, USERPROFILE: home, CM_HOOK_OVERHEAD_BUDGET_MS: "60000" } };
}

const COMMENTED = `{
  // my servers
  "servers": {
    /* keep this one */
    "other": { "command": "other-server", },
  },
}
`;

test("VS-WIN-5: vscode mcp.json with comments and trailing commas is set up, comments kept, doctor passes", async (t) => {
  const s = sandbox(t);
  const file = path.join(s.home, ".vscode", "mcp.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, COMMENTED);
  const res = await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["vscode"], runId: "j" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents));
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("// my servers") && text.includes("/* keep this one */"), "the user's comments stay");
  assert.ok(text.includes('"context-mode"'), "the own entry is written");
  const doc = await runDoctor({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["vscode"] });
  assert.equal(doc.exitCode, 0, JSON.stringify(doc.agents));
});

test("VS-WIN-5: a commented opencode.json (MCP entry and plugin list) is read as JSONC and keeps its comments", async (t) => {
  const s = sandbox(t);
  const file = path.join(s.home, ".config", "opencode", "opencode.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `{\n  // mine\n  "theme": "dark",\n}\n`);
  const res = await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["opencode"], runId: "o" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents));
  const text = readFileSync(file, "utf8");
  assert.ok(text.includes("// mine") && text.includes('"context-mode"') && text.includes('"plugin"'), text);
  const doc = await runDoctor({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["opencode"] });
  assert.ok(!JSON.stringify(doc.agents).includes("does not parse"), JSON.stringify(doc.agents));
});
