// D-HW-PS-1: the hook command setup writes starts with a quoted node path. cmd.exe /C "..." (codex) and sh accept
// that; PowerShell reads a leading quoted string as a string literal and fails to parse the rest. The Copilot
// harness (copilot-cli, vscode) runs `command` through PowerShell on Windows unless an explicit `powershell` field
// is set (docs.github.com/en/copilot/reference/hooks-reference: "explicit bash or powershell entries take
// precedence on their respective platforms"). So those two hosts get `powershell: "& " + command`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildRegistry, hookCommandString } from "../../../src/setup/index.ts";

// Fake Windows paths: the registry only joins strings, so this runs on every OS.
const WIN_HOME = "C:\\Users\\Jane Doe";
const WIN_PKG = "C:\\Program Files\\nodejs\\node_modules\\context-mode";

function hookEntries(row) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") { if (typeof v.command === "string") out.push(v); for (const x of Object.values(v)) walk(x); }
  };
  walk(row.hookInstall.shape);
  return out;
}

test("D-HW-PS-1: copilot-cli and vscode hook entries carry an explicit powershell field: call operator + the command", () => {
  const reg = buildRegistry({ home: WIN_HOME, pkgDir: WIN_PKG, env: {} });
  for (const id of ["copilot-cli", "vscode"]) {
    const row = reg.find((r) => r.id === id);
    const entries = hookEntries(row);
    assert.ok(entries.length > 0, id + " has hook entries");
    for (const e of entries) {
      assert.equal(e.command, row.hookInstall.command, id + ": command stays the sh/cmd form");
      assert.equal(e.powershell, "& " + row.hookInstall.command, id + ": powershell field starts with the call operator");
      assert.ok(e.command.startsWith('"'), id + ": command starts with a quoted path (what PowerShell cannot parse)");
    }
  }
});

test("D-HW-PS-1: every other host keeps command only (their shell is cmd.exe, sh, or not documented)", () => {
  const reg = buildRegistry({ home: WIN_HOME, pkgDir: WIN_PKG, env: {} });
  for (const row of reg.filter((r) => r.hookInstall.kind === "file" && !["copilot-cli", "vscode"].includes(r.id))) {
    for (const e of hookEntries(row)) assert.equal(e.powershell, undefined, row.id + ": no powershell field");
  }
});

// Only a real Windows run proves PowerShell's parser: the quoted-first form fails, the `& ` form runs.
test("D-HW-PS-1: Windows PowerShell runs the powershell field and rejects the bare quoted form", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "cm ps "));
  try {
    const dir = path.join(root, "pkg dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hook.mjs"), "process.stdout.write('ran:' + process.argv.slice(2).join(' '));\n");
    const reg = buildRegistry({ home: root, pkgDir: dir, env: {} });
    const row = reg.find((r) => r.id === "copilot-cli");
    const entry = hookEntries(row)[0];
    const ps = (line) => spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", line], { encoding: "utf8", windowsHide: true });
    const bare = ps(hookCommandString(row));
    assert.notEqual(bare.status, 0, "bare quoted form is a PowerShell parse error: " + bare.stdout);
    const good = ps(entry.powershell);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout.trim(), "ran:--agent copilot-cli");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
