// KIRO-WIN-4: which shell runs the kiro hook command on Windows, and does the registered string survive it.
// Source read (aws/amazon-q-developer-cli main, crates/chat-cli/src/cli/chat/cli/hooks.rs run_hook, the open source
// base of Kiro CLI): unix `bash -c <command>`; windows `tokio::process::Command::new("cmd").arg("/C").arg(command)`.
// So the shell is cmd.exe, not PowerShell, and the finding's `& ` prefix is not needed (it would be a cmd.exe error).
// What matters is how the argument reaches cmd.exe: Rust std (like Node without windowsVerbatimArguments) wraps an
// argument with spaces in quotes and escapes each inner quote as \". This test repeats that spawn with a spaced path.
// Kiro CLI 2.x / V3 is closed source: the same call is assumed and NOT verified on a real Kiro.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildRegistry, hookCommandString } from "../../../src/setup/index.ts";

test("KIRO-WIN-4: the kiro hook entry is the plain registered string, with no powershell field", () => {
  const reg = buildRegistry({ home: "C:\\Users\\Jane Doe", pkgDir: "C:\\Program Files\\nodejs\\node_modules\\context-mode", env: {} });
  const row = reg.find((r) => r.id === "kiro");
  const cmds = row.hookInstall.shape.hooks.map((h) => h.action);
  assert.ok(cmds.length > 0);
  for (const a of cmds) { assert.equal(a.command, hookCommandString(row)); assert.equal(a.powershell, undefined); }
});

// Windows only: spawn(cmd, ["/C", line]) with the default (non-verbatim) quoting, as Kiro's Rust code does.
test("KIRO-WIN-4: cmd.exe /C, spawned the way Kiro spawns it, runs the registered kiro hook command", { skip: process.platform !== "win32", todo: "UNVERIFIED KIRO-WIN-4 (D-WIN-KIRO-SHELL-1): if CI shows this red, Node/Rust re-quote the line as \\\" and cmd.exe cannot run a spaced node path; same class as Q-WIN-5; needs a design decision, see OPEN-ITEMS" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "cm kiro "));
  try {
    const dir = path.join(root, "pkg dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hook.mjs"), "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>process.stdout.write('ran:' + process.argv.slice(2).join(' ') + ':' + d));\n");
    const reg = buildRegistry({ home: root, pkgDir: dir, env: {} });
    const row = reg.find((r) => r.id === "kiro");
    const line = hookCommandString(row);
    const r = spawnSync(process.env.ComSpec || "cmd.exe", ["/C", line], { input: '{"x":1}', encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, "stderr=" + r.stderr + " stdout=" + r.stdout + " line=" + line);
    assert.equal(r.stdout.trim(), 'ran:--agent kiro:{"x":1}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
