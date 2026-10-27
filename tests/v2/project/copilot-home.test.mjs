// D-WIN-COPILOT-HOME-1: Copilot CLI reads hooks/ and skills/ from $COPILOT_HOME (it replaces ~/.copilot as a whole;
// docs.github.com cli-config-dir-reference). One helper (copilotDirOf) feeds setup, detection, doctor and the v1 scan.
// Fake Windows paths: path.join is the host's, so the assertions compare against path.join of the same inputs and run on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { copilotDirOf } from "../../../src/core/project/config-dir.ts";
import { buildRegistry } from "../../../src/setup/registry.ts";

const WIN_HOME = "C:\\Users\\Jo Doe";
const WIN_CFG = "D:\\OneDrive - Corp\\copilot cfg";

test("copilotDirOf: COPILOT_HOME wins, empty counts as unset, default is <home>/.copilot", () => {
  assert.equal(copilotDirOf({ COPILOT_HOME: WIN_CFG }, WIN_HOME), WIN_CFG);
  assert.equal(copilotDirOf({ COPILOT_HOME: "" }, WIN_HOME), path.join(WIN_HOME, ".copilot"));
  assert.equal(copilotDirOf({}, WIN_HOME), path.join(WIN_HOME, ".copilot"));
});

test("registry: copilot-cli hook file, skills dir and allowed writes follow COPILOT_HOME; vscode stays under <home>", () => {
  const reg = buildRegistry({ home: WIN_HOME, pkgDir: "/abs/pkg", env: { COPILOT_HOME: WIN_CFG } });
  const row = reg.find((r) => r.id === "copilot-cli");
  assert.equal(row.hookFiles[0].file, path.join(WIN_CFG, "hooks", "context-mode.json"));
  assert.equal(row.hookInstall.file, path.join(WIN_CFG, "hooks", "context-mode.json"));
  assert.equal(row.skillInstall.dir, path.join(WIN_CFG, "skills"));
  assert.ok(row.allowedWrites.includes(path.resolve(path.join(WIN_CFG, "hooks", "context-mode.json"))));
  assert.ok(!row.allowedWrites.some((f) => f.includes(".copilot")), "nothing is written under <home>/.copilot");
  const vs = reg.find((r) => r.id === "vscode");
  assert.equal(vs.hookInstall.file, path.join(WIN_HOME, ".copilot", "hooks", "context-mode-vscode.json"), "VS Code is not Copilot CLI");
});

test("registry: copilot-cli without COPILOT_HOME keeps <home>/.copilot", () => {
  const row = buildRegistry({ home: WIN_HOME, pkgDir: "/abs/pkg", env: {} }).find((r) => r.id === "copilot-cli");
  assert.equal(row.hookInstall.file, path.join(WIN_HOME, ".copilot", "hooks", "context-mode.json"));
  assert.equal(row.skillInstall.dir, path.join(WIN_HOME, ".copilot", "skills"));
});

test("detectAgents sees copilot-cli through COPILOT_HOME; detectV1 scans the v1 hook file there", async (t) => {
  const { detectAgents } = await import("../../../src/setup/engine.ts");
  const { detectV1 } = await import("../../../src/core/ops/detect-v1.ts");
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-cp-home-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cfg = path.join(root, "copilot cfg");
  const tmp = path.join(root, "tmp");
  for (const d of [home, cfg, tmp, path.join(cfg, "hooks")]) mkdirSync(d, { recursive: true });
  const ctx = { home, pkgDir: "/abs/pkg", env: { PATH: "", COPILOT_HOME: cfg } };
  const reg = buildRegistry(ctx);
  assert.ok(detectAgents(reg, ctx).includes("copilot-cli"), "COPILOT_HOME dir marks the host present");
  assert.ok(!detectAgents(reg, { ...ctx, env: { PATH: "" } }).includes("copilot-cli"), "no dir, no detection");
  writeFileSync(path.join(cfg, "hooks", "context-mode.json"), JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: "command", command: "context-mode hook copilot-cli" }] } }));
  const found = detectV1("copilot-cli", home, { copilotDir: cfg, tmp });
  assert.ok(found.some((f) => f.file === path.join(cfg, "hooks", "context-mode.json")), JSON.stringify(found));
});

test("setup writes copilot-cli hooks and skills under COPILOT_HOME and doctor reads them there", async (t) => {
  const { runSetup, runDoctor } = await import("../../../src/setup/index.ts");
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-cp-run-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cfg = path.join(root, "copilot cfg");
  const bin = path.join(root, "bin");
  mkdirSync(home, { recursive: true }); mkdirSync(bin, { recursive: true });
  if (process.platform === "win32") writeFileSync(path.join(bin, "copilot.cmd"), "@echo context-mode\r\n");
  else writeFileSync(path.join(bin, "copilot"), "#!/bin/sh\necho context-mode\n", { mode: 0o755 });
  const { cpSync, existsSync, readFileSync } = await import("node:fs");
  const { generateManifests } = await import("../../../build/manifests.ts");
  const repo = path.resolve(import.meta.dirname, "../../..");
  const pkgDir = path.join(root, "pkg");
  mkdirSync(pkgDir, { recursive: true });
  const { TOOL_ORDER } = await import("../../../src/core/contracts/constants.ts");
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
  for (const base of ["skills", "pi/skills", "claude-code/skills"]) for (const n of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) cpSync(path.join(repo, "skills", n), path.join(pkgDir, base, n), { recursive: true });
  const win = process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {};
  const env = { PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter), HOME: home, USERPROFILE: home, COPILOT_HOME: cfg, CM_HOOK_OVERHEAD_BUDGET_MS: "60000", ...win };
  const res = await runSetup({ home, pkgDir, env, agents: ["copilot-cli"], runId: "cp" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
  assert.ok(existsSync(path.join(cfg, "hooks", "context-mode.json")), "hook file under COPILOT_HOME/hooks");
  for (const n of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) assert.ok(existsSync(path.join(cfg, "skills", n, "SKILL.md")), n);
  assert.equal(existsSync(path.join(home, ".copilot")), false, "nothing written to HOME/.copilot");
  const d = await runDoctor({ home, pkgDir, env, agents: ["copilot-cli"] });
  const checks = d.agents[0].checks;
  assert.equal(checks.find((c) => c.name === "skills")?.ok, true, JSON.stringify(checks));
  assert.equal(readFileSync(path.join(cfg, "hooks", "context-mode.json"), "utf8").includes("copilot-cli"), true);
});
