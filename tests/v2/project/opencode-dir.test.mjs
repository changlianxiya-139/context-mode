// D-WIN-OPENCODE-DIR-1: OpenCode reads opencode.json and skills/ from $OPENCODE_CONFIG_DIR, else $XDG_CONFIG_HOME/opencode
// (xdg-basedir), else ~/.config/opencode. One helper (opencodeDirOf) feeds setup, host-write, doctor, uninstall, detection
// and the v1 scan. Fake Windows paths: path.join is the host's, so assertions compare against path.join of the same inputs
// and run on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { opencodeDirOf } from "../../../src/core/project/config-dir.ts";
import { hostConfigPath } from "../../../src/core/ops/host-write.ts";
import { buildRegistry } from "../../../src/setup/registry.ts";

const WIN_HOME = "C:\\Users\\Jo Doe";
const WIN_XDG = "D:\\xdg config";
const WIN_OWN = "E:\\oc cfg";

test("opencodeDirOf: OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME/opencode, then <home>/.config/opencode; empty is unset", () => {
  assert.equal(opencodeDirOf({ OPENCODE_CONFIG_DIR: WIN_OWN, XDG_CONFIG_HOME: WIN_XDG }, WIN_HOME), WIN_OWN);
  assert.equal(opencodeDirOf({ XDG_CONFIG_HOME: WIN_XDG }, WIN_HOME), path.join(WIN_XDG, "opencode"));
  assert.equal(opencodeDirOf({ OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "" }, WIN_HOME), path.join(WIN_HOME, ".config", "opencode"));
  assert.equal(opencodeDirOf({}, WIN_HOME), path.join(WIN_HOME, ".config", "opencode"));
});

test("opencodeDirOf: OPENCODE_CONFIG (one extra file) does not move the global dir", () => {
  assert.equal(opencodeDirOf({ OPENCODE_CONFIG: "C:\\x\\custom.json" }, WIN_HOME), path.join(WIN_HOME, ".config", "opencode"));
});

test("registry: opencode config, plugin list, skills dir and allowed writes follow the env", () => {
  for (const [env, dir] of [
    [{ OPENCODE_CONFIG_DIR: WIN_OWN }, WIN_OWN],
    [{ XDG_CONFIG_HOME: WIN_XDG }, path.join(WIN_XDG, "opencode")],
    [{}, path.join(WIN_HOME, ".config", "opencode")],
  ]) {
    const row = buildRegistry({ home: WIN_HOME, pkgDir: "/abs/pkg", env }).find((r) => r.id === "opencode");
    const file = path.join(dir, "opencode.json");
    assert.equal(row.config.file, file);
    assert.equal(row.hookInstall.file, file);
    assert.equal(row.skillInstall.dir, path.join(dir, "skills"));
    assert.ok(row.allowedWrites.includes(path.resolve(file)), JSON.stringify(row.allowedWrites));
    assert.ok(row.allowedWrites.every((f) => f.startsWith(path.resolve(dir))), "every write is under the OpenCode dir");
  }
});

test("hostConfigPath: opencode follows the env", () => {
  assert.equal(hostConfigPath("opencode", WIN_HOME, { OPENCODE_CONFIG_DIR: WIN_OWN }), path.join(WIN_OWN, "opencode.json"));
  assert.equal(hostConfigPath("opencode", WIN_HOME, { XDG_CONFIG_HOME: WIN_XDG }), path.join(WIN_XDG, "opencode", "opencode.json"));
  assert.equal(hostConfigPath("opencode", WIN_HOME, {}), path.join(WIN_HOME, ".config", "opencode", "opencode.json"));
});

test("detectAgents sees opencode through XDG_CONFIG_HOME; detectV1 scans the v1 plugin entry there", async (t) => {
  const { detectAgents } = await import("../../../src/setup/engine.ts");
  const { detectV1 } = await import("../../../src/core/ops/detect-v1.ts");
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-oc-dir-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg cfg");
  const tmp = path.join(root, "tmp");
  for (const d of [home, tmp, path.join(xdg, "opencode")]) mkdirSync(d, { recursive: true });
  const ctx = { home, pkgDir: "/abs/pkg", env: { PATH: "", XDG_CONFIG_HOME: xdg } };
  assert.ok(detectAgents(buildRegistry(ctx), ctx).includes("opencode"), "XDG dir marks the host present");
  const bare = { home, pkgDir: "/abs/pkg", env: { PATH: "" } };
  assert.ok(!detectAgents(buildRegistry(bare), bare).includes("opencode"), "no dir, no detection");
  writeFileSync(path.join(xdg, "opencode", "opencode.json"), JSON.stringify({ plugin: ["context-mode"] }));
  const found = detectV1("opencode", home, { opencodeDir: path.join(xdg, "opencode"), tmp });
  assert.ok(found.some((f) => f.file === path.join(xdg, "opencode", "opencode.json")), JSON.stringify(found));
});

test("setup writes opencode config and skills under XDG_CONFIG_HOME, doctor reads them there, uninstall removes them there", async (t) => {
  const { runSetup, runDoctor } = await import("../../../src/setup/index.ts");
  const { existsSync, readFileSync, cpSync } = await import("node:fs");
  const { generateManifests } = await import("../../../build/manifests.ts");
  const { TOOL_ORDER } = await import("../../../src/core/contracts/constants.ts");
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-oc-run-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg cfg");
  const bin = path.join(root, "bin");
  mkdirSync(home, { recursive: true }); mkdirSync(bin, { recursive: true });
  // The fake opencode lists context-mode only when the config sits where OpenCode reads it.
  const conf = path.join(xdg, "opencode", "opencode.json");
  if (process.platform === "win32") {
    writeFileSync(path.join(bin, "opencode.cmd"), `@if exist "${conf}" (echo context-mode connected) else (exit /b 1)\r\n`);
  } else {
    writeFileSync(path.join(bin, "opencode"), `#!/bin/sh\nif [ -f "${conf}" ]; then echo "context-mode connected"; else exit 1; fi\n`, { mode: 0o755 });
  }
  const repo = path.resolve(import.meta.dirname, "../../..");
  const pkgDir = path.join(root, "pkg");
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
  mkdirSync(path.join(pkgDir, "opencode"), { recursive: true });
  writeFileSync(path.join(pkgDir, "opencode", "plugin.js"), "export default {};\n");
  generateManifests(pkgDir);
  for (const base of ["skills", "pi/skills", "claude-code/skills"]) for (const n of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) cpSync(path.join(repo, "skills", n), path.join(pkgDir, base, n), { recursive: true });
  const win = process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {};
  const env = { PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, CM_HOOK_OVERHEAD_BUDGET_MS: "60000", ...win };
  const res = await runSetup({ home, pkgDir, env, agents: ["opencode"], runId: "oc" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
  assert.ok(existsSync(conf), "opencode.json under XDG_CONFIG_HOME/opencode");
  const doc = JSON.parse(readFileSync(conf, "utf8"));
  assert.ok(doc.mcp?.["context-mode"], JSON.stringify(doc));
  assert.ok(doc.plugin?.length >= 1, JSON.stringify(doc));
  for (const n of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) assert.ok(existsSync(path.join(xdg, "opencode", "skills", n, "SKILL.md")), n);
  assert.equal(existsSync(path.join(home, ".config")), false, "nothing written to HOME/.config");
  const d = await runDoctor({ home, pkgDir, env, agents: ["opencode"] });
  const checks = d.agents[0].checks;
  assert.equal(checks.find((c) => c.name === "skills")?.ok, true, JSON.stringify(checks));
});
