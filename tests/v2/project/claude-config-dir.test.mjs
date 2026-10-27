// D-WF-CC-CONFIG-1: Claude Code reads its user dir from $CLAUDE_CONFIG_DIR (default <home>/.claude). Windows users with
// OneDrive-redirected profiles set it. One helper (claudeDirOf) feeds setup, doctor, plugin-root and the subagent reader.
// Fake Windows paths: path.join is the host's, so the assertions compare against path.join of the same inputs and run on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { claudeDirOf } from "../../../src/core/project/config-dir.ts";
import { buildRegistry } from "../../../src/setup/registry.ts";
import { resolvePluginRoot } from "../../../src/core/ops/plugin-root.ts";

const WIN_HOME = "C:\\Users\\Jo Doe";
const WIN_CFG = "D:\\OneDrive - Corp\\claude cfg";

test("claudeDirOf: CLAUDE_CONFIG_DIR wins, empty counts as unset, default is <home>/.claude", () => {
  assert.equal(claudeDirOf({ CLAUDE_CONFIG_DIR: WIN_CFG }, WIN_HOME), WIN_CFG);
  assert.equal(claudeDirOf({ CLAUDE_CONFIG_DIR: "" }, WIN_HOME), path.join(WIN_HOME, ".claude"));
  assert.equal(claudeDirOf({}, WIN_HOME), path.join(WIN_HOME, ".claude"));
});

test("registry: claude-code settings.json (drop) and installed_plugins.json (copy) follow CLAUDE_CONFIG_DIR", () => {
  const reg = buildRegistry({ home: WIN_HOME, pkgDir: "/abs/pkg", env: { CLAUDE_CONFIG_DIR: WIN_CFG } });
  const row = reg.find((r) => r.id === "claude-code");
  assert.equal(row.hookFiles[0].file, path.join(WIN_CFG, "settings.json"));
  assert.equal(row.copy.file, path.join(WIN_CFG, "plugins", "installed_plugins.json"));
  assert.ok(row.allowedWrites.includes(path.resolve(path.join(WIN_CFG, "settings.json"))), "the drop target is an allowed write");
  assert.ok(!row.allowedWrites.some((f) => f.includes(".claude")), "nothing is written under <home>/.claude");
});

test("registry: claude-code without CLAUDE_CONFIG_DIR keeps <home>/.claude", () => {
  const row = buildRegistry({ home: WIN_HOME, pkgDir: "/abs/pkg", env: {} }).find((r) => r.id === "claude-code");
  assert.equal(row.hookFiles[0].file, path.join(WIN_HOME, ".claude", "settings.json"));
  assert.equal(row.copy.file, path.join(WIN_HOME, ".claude", "plugins", "installed_plugins.json"));
});

test("plugin-root: the marketplace cache is found under CLAUDE_CONFIG_DIR", (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-cc-cfg-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cfg = path.join(root, "one drive", "claude cfg");
  const cache = path.join(cfg, "plugins", "cache", "mp", "context-mode");
  mkdirSync(cache, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "keep"), "");
  assert.equal(resolvePluginRoot({ id: "claude-code", installMode: "marketplace" }, { HOME: home, CLAUDE_CONFIG_DIR: cfg }), cache);
});

test("detectV1 and detectAgents read CLAUDE_CONFIG_DIR, not <home>/.claude", async (t) => {
  const { detectV1 } = await import("../../../src/core/ops/detect-v1.ts");
  const { detectAgents } = await import("../../../src/setup/engine.ts");
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-cc-v1-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const cfg = path.join(root, "cfg dir");
  mkdirSync(home, { recursive: true });
  mkdirSync(cfg, { recursive: true });
  const tmp = path.join(root, "tmp"); // an empty OS-temp stand-in: detectV1 also reports context-mode-* files there
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "context-mode hook claudecode pretooluse" }] }] } }));
  assert.deepEqual(detectV1("claude-code", home, { tmp }), [], "default scope looks under <home>/.claude, which is empty");
  const found = detectV1("claude-code", home, { claudeDir: cfg, tmp });
  assert.ok(found.length > 0 && found.every((f) => f.file.startsWith(cfg)), "the v1 hook in CLAUDE_CONFIG_DIR is found");
  const reg = buildRegistry({ home, pkgDir: "/abs/pkg", env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.ok(detectAgents(reg, { home, pkgDir: "/abs/pkg", env: { CLAUDE_CONFIG_DIR: cfg, PATH: "" } }).includes("claude-code"));
  assert.ok(!detectAgents(reg, { home, pkgDir: "/abs/pkg", env: { PATH: "" } }).includes("claude-code"));
});

// Only a real Windows run proves that a backslash CLAUDE_CONFIG_DIR with a space survives path.join and path.resolve.
test("registry: a real Windows CLAUDE_CONFIG_DIR with backslashes and a space is used as is", { skip: process.platform !== "win32" && "windows only" }, () => {
  const row = buildRegistry({ home: "C:\\Users\\Jo Doe", pkgDir: "C:\\pkg dir", env: { CLAUDE_CONFIG_DIR: WIN_CFG } }).find((r) => r.id === "claude-code");
  assert.equal(row.hookFiles[0].file, "D:\\OneDrive - Corp\\claude cfg\\settings.json");
  assert.deepEqual(row.allowedWrites.filter((f) => f.endsWith("settings.json")), ["D:\\OneDrive - Corp\\claude cfg\\settings.json"]);
});
