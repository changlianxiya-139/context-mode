// D-WIN-KIRO-HOME-1: Kiro CLI V3 takes its global dir from $KIRO_HOME (kiro.dev/docs/reference/settings: "overrides the global
// Kiro directory"; a filesystem root, the home dir, one of its ancestors or a relative path falls back to ~/.kiro).
// One helper (kiroDirOf) feeds setup, detection, doctor, uninstall, host-write, upgrade and the v1 scan.
// Fake Windows paths with an explicit platform, so the rule runs on every OS; registry assertions compare with path.join.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { kiroDirOf } from "../../../src/core/project/config-dir.ts";
import { buildRegistry } from "../../../src/setup/registry.ts";
import { hostConfigPath } from "../../../src/core/ops/host-write.ts";

const WIN_HOME = "C:\\Users\\Jo Doe";
const WIN_KIRO = "D:\\Profiles\\work kiro";
// Host-absolute paths for the registry tests: kiroDirOf checks absoluteness with the real platform.
const HOME = path.resolve(path.sep, "Users", "Jo Doe");
const KIRO = path.resolve(path.sep, "Profiles", "work kiro");
const DEFAULT_WIN = path.win32.join(WIN_HOME, ".kiro");

test("kiroDirOf: an absolute KIRO_HOME wins on win32 and posix", () => {
  assert.equal(kiroDirOf({ KIRO_HOME: WIN_KIRO }, WIN_HOME, "win32"), WIN_KIRO);
  assert.equal(kiroDirOf({ KIRO_HOME: "/work/kiro" }, "/home/jo", "linux"), "/work/kiro");
});

test("kiroDirOf: unset, empty, relative, root, home and an ancestor of home fall back to <home>/.kiro", () => {
  for (const v of [undefined, "", "kiro-profile", ".\\kiro", "C:\\", "D:\\", "\\kiro", WIN_HOME, WIN_HOME + "\\", "C:\\Users", "c:\\users\\jo doe"]) {
    assert.equal(kiroDirOf({ KIRO_HOME: v }, WIN_HOME, "win32"), DEFAULT_WIN, JSON.stringify(v));
  }
  for (const v of ["", "rel/kiro", "/", "/home/jo", "/home", "/home/jo/"]) {
    assert.equal(kiroDirOf({ KIRO_HOME: v }, "/home/jo", "linux"), "/home/jo/.kiro", JSON.stringify(v));
  }
  assert.equal(kiroDirOf({}, "/home/jo", "linux"), "/home/jo/.kiro");
});

test("kiroDirOf: a dir beside or under home is accepted", () => {
  assert.equal(kiroDirOf({ KIRO_HOME: "C:\\Users\\Jo Doe.kiro" }, WIN_HOME, "win32"), "C:\\Users\\Jo Doe.kiro");
  assert.equal(kiroDirOf({ KIRO_HOME: "C:\\Users\\Jo Doe\\profiles\\work" }, WIN_HOME, "win32"), "C:\\Users\\Jo Doe\\profiles\\work");
  assert.equal(kiroDirOf({ KIRO_HOME: "/home/jo/..kiro" }, "/home/jo", "linux"), "/home/jo/..kiro");
});

test("registry: kiro hook file, MCP file, skills dir and allowed writes follow KIRO_HOME", () => {
  const reg = buildRegistry({ home: HOME, pkgDir: "/abs/pkg", env: { KIRO_HOME: KIRO } });
  const row = reg.find((r) => r.id === "kiro");
  assert.equal(row.hookInstall.file, path.join(KIRO, "hooks", "context-mode.json"));
  assert.equal(row.config.file, path.join(KIRO, "settings", "mcp.json"));
  assert.equal(row.skillInstall.dir, path.join(KIRO, "skills"));
  assert.ok(row.allowedWrites.includes(path.resolve(path.join(KIRO, "settings", "mcp.json"))));
  assert.ok(!row.allowedWrites.some((f) => f.includes(".kiro")), "nothing is written under <home>/.kiro");
  assert.equal(hostConfigPath("kiro", HOME, { KIRO_HOME: KIRO }), path.join(KIRO, "settings", "mcp.json"));
});

test("registry: kiro without KIRO_HOME (or with a value Kiro ignores) keeps <home>/.kiro", () => {
  for (const env of [{}, { KIRO_HOME: "" }, { KIRO_HOME: "relative" }]) {
    const row = buildRegistry({ home: HOME, pkgDir: "/abs/pkg", env }).find((r) => r.id === "kiro");
    assert.equal(row.hookInstall.file, path.join(HOME, ".kiro", "hooks", "context-mode.json"), JSON.stringify(env));
    assert.equal(row.config.file, path.join(HOME, ".kiro", "settings", "mcp.json"));
    assert.equal(row.skillInstall.dir, path.join(HOME, ".kiro", "skills"));
  }
});

test("registry: other hosts ignore KIRO_HOME", () => {
  const reg = buildRegistry({ home: HOME, pkgDir: "/abs/pkg", env: { KIRO_HOME: KIRO } });
  assert.ok(!reg.find((r) => r.id === "gemini").allowedWrites.some((f) => f.includes("work kiro")));
});

test("detectAgents sees kiro through KIRO_HOME; detectV1 scans the v1 agent file there", async (t) => {
  const { detectAgents } = await import("../../../src/setup/engine.ts");
  const { detectV1 } = await import("../../../src/core/ops/detect-v1.ts");
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-kiro-home-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cfg = path.join(root, "kiro cfg");
  const tmp = path.join(root, "tmp");
  for (const d of [home, cfg, tmp, path.join(cfg, "agents")]) mkdirSync(d, { recursive: true });
  const ctx = { home, pkgDir: "/abs/pkg", env: { PATH: "", KIRO_HOME: cfg } };
  const reg = buildRegistry(ctx);
  assert.ok(detectAgents(reg, ctx).includes("kiro"), "KIRO_HOME dir marks the host present");
  assert.ok(!detectAgents(reg, { ...ctx, env: { PATH: "" } }).includes("kiro"), "no dir, no detection");
  writeFileSync(path.join(cfg, "agents", "old.json"), JSON.stringify({ name: "context-mode" }));
  const found = detectV1("kiro", home, { kiroDir: cfg, tmp });
  assert.ok(found.some((f) => f.file === path.join(cfg, "agents", "old.json")), JSON.stringify(found));
});

test("setup writes kiro hooks, MCP entry and skills under KIRO_HOME and doctor reads them there", async (t) => {
  const { runSetup, runDoctor } = await import("../../../src/setup/index.ts");
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-kiro-run-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cfg = path.join(root, "kiro cfg");
  const bin = path.join(root, "bin");
  mkdirSync(home, { recursive: true }); mkdirSync(bin, { recursive: true });
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
  const env = { PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter), HOME: home, USERPROFILE: home, KIRO_HOME: cfg, CM_HOOK_OVERHEAD_BUDGET_MS: "60000", ...win };
  const res = await runSetup({ home, pkgDir, env, agents: ["kiro"], runId: "ki" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
  assert.ok(existsSync(path.join(cfg, "hooks", "context-mode.json")), "hook file under KIRO_HOME/hooks");
  assert.ok(existsSync(path.join(cfg, "settings", "mcp.json")), "MCP entry under KIRO_HOME/settings");
  for (const n of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) assert.ok(existsSync(path.join(cfg, "skills", n, "SKILL.md")), n);
  assert.equal(existsSync(path.join(home, ".kiro")), false, "nothing written to HOME/.kiro");
  const d = await runDoctor({ home, pkgDir, env, agents: ["kiro"] });
  const checks = d.agents[0].checks;
  assert.equal(checks.find((c) => c.name === "skills")?.ok, true, JSON.stringify(checks));
  assert.equal(checks.some((c) => c.ok === false && String(c.detail ?? "").includes(path.join(home, ".kiro"))), false, "doctor names no <home>/.kiro file: " + JSON.stringify(checks));
  assert.equal(readFileSync(path.join(cfg, "hooks", "context-mode.json"), "utf8").includes("kiro"), true);
});
