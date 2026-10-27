// D-WIN-VSCODE-MCP-1 (VS-WIN-2): VS Code reads the user-profile mcp.json from its user data dir, not from ~/.vscode
// (the extensions dir). Rule from microsoft/vscode src/vs/platform/environment/node/userDataPath.ts and
// src/vs/platform/userDataProfile/common/userDataProfile.ts (default profile = userRoamingDataHome = <data>/Code/User,
// mcpResource = <profile>/mcp.json): win32 %APPDATA% (else <home>\AppData\Roaming), darwin <home>/Library/Application Support,
// linux $XDG_CONFIG_HOME (else <home>/.config). One helper (vscodeUserDirOf) feeds setup, doctor, upgrade, uninstall and plugin-root.
// Fake Windows paths: the helper takes the platform, so the first group runs on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vscodeUserDirOf } from "../../../src/core/project/config-dir.ts";
import { hostConfigPath } from "../../../src/core/ops/host-write.ts";
import { runUninstall } from "../../../src/core/ops/uninstall.ts";
import { resolvePluginRoot } from "../../../src/core/ops/plugin-root.ts";
import { getAdapter } from "../../../src/adapters/table.ts";

const WIN_HOME = "C:\\Users\\Jo Doe";

test("vscodeUserDirOf win32: %APPDATA%\\Code\\User, else <home>\\AppData\\Roaming\\Code\\User, empty APPDATA is unset", () => {
  assert.equal(vscodeUserDirOf({ APPDATA: "D:\\Roam ing" }, WIN_HOME, "win32"), "D:\\Roam ing\\Code\\User");
  assert.equal(vscodeUserDirOf({}, WIN_HOME, "win32"), "C:\\Users\\Jo Doe\\AppData\\Roaming\\Code\\User");
  assert.equal(vscodeUserDirOf({ APPDATA: "" }, WIN_HOME, "win32"), "C:\\Users\\Jo Doe\\AppData\\Roaming\\Code\\User");
});

test("vscodeUserDirOf darwin: <home>/Library/Application Support/Code/User; XDG_CONFIG_HOME and APPDATA do not apply", () => {
  assert.equal(vscodeUserDirOf({ XDG_CONFIG_HOME: "/x", APPDATA: "/y" }, "/Users/jo", "darwin"), "/Users/jo/Library/Application Support/Code/User");
});

test("vscodeUserDirOf linux: $XDG_CONFIG_HOME/Code/User, else <home>/.config/Code/User, empty is unset", () => {
  assert.equal(vscodeUserDirOf({ XDG_CONFIG_HOME: "/cfg dir" }, "/home/jo", "linux"), "/cfg dir/Code/User");
  assert.equal(vscodeUserDirOf({}, "/home/jo", "linux"), "/home/jo/.config/Code/User");
  assert.equal(vscodeUserDirOf({ XDG_CONFIG_HOME: "" }, "/home/jo", "linux"), "/home/jo/.config/Code/User");
});

function tmp(t) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-vscdir-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The same rule spelled out per host OS, so the test is not the helper checking itself.
function expectedFile(home, env) {
  const tail = ["Code", "User", "mcp.json"];
  if (process.platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), ...tail);
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", ...tail);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), ...tail);
}

test("hostConfigPath vscode: the user-profile mcp.json, never <home>/.vscode/mcp.json", (t) => {
  const home = tmp(t);
  for (const env of [{}, { APPDATA: path.join(home, "Roam ing"), XDG_CONFIG_HOME: path.join(home, "xdg") }]) {
    const got = hostConfigPath("vscode", home, env);
    assert.equal(got, expectedFile(home, env));
    assert.notEqual(got, path.join(home, ".vscode", "mcp.json"));
  }
});

test("uninstall vscode: drops context-mode from the user-profile mcp.json, keeps other servers", (t) => {
  const home = tmp(t);
  const env = { HOME: home, USERPROFILE: home };
  const file = expectedFile(home, env);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ servers: { other: { command: "o" }, "context-mode": { command: "node", args: ["/opt/cm/server.mjs"] } } }), "utf8");
  runUninstall({ adapter: { id: "vscode", installMode: "hooks+mcp" }, project: { projectKey: "abcdef0123456789" }, env, confirmDelete: false });
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(after.servers["context-mode"], undefined);
  assert.deepEqual(after.servers.other, { command: "o" });
});

test("plugin-root vscode: the server dir comes from the entry in the user-profile mcp.json", (t) => {
  const home = tmp(t);
  const env = { HOME: home, USERPROFILE: home };
  const pkg = path.join(home, "pkg");
  mkdirSync(pkg, { recursive: true });
  const file = expectedFile(home, env);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ servers: { "context-mode": { command: "node", args: [path.join(pkg, "server.mjs")] } } }), "utf8");
  assert.equal(resolvePluginRoot(getAdapter("vscode"), env), pkg);
  assert.equal(existsSync(path.join(home, ".vscode", "mcp.json")), false);
});
