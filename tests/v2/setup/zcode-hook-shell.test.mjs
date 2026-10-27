// Z-WIN-3: which shell runs the zcode hook command on Windows, and does the registered string survive it.
// Source read (zai-org/ZCode main, apps/zcode-cli/packages): core/src/hooks/configured-runner-callback.ts runs a
// `type: "command"` hook as ExecutionCommand mode "shell" with no shellProfile; adapters/src/exec/execution-command.ts
// resolveExecutionCommand -> resolveShell returns `shell: process.env.ComSpec ?? "cmd.exe"` on win32 (or the hook's own
// `shell` field), file = the command string, args = []; exec/node-execution-adapter-process.ts passes that to Node
// child_process.spawn({ shell }). Node, for a shell that matches cmd(.exe), runs `<shell> /d /s /c "<command>"` with
// windowsVerbatimArguments. So cmd strips only the outer pair and the leading-quoted node path is valid: no `& `, no
// extra quote wrap, and the `process` handler type is not needed. This test repeats that spawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildRegistry, hookCommandString } from "../../../src/setup/index.ts";

function commandEntries(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => commandEntries(x, out));
  else if (v && typeof v === "object") { if (typeof v.command === "string") out.push(v); for (const x of Object.values(v)) commandEntries(x, out); }
  return out;
}

test("Z-WIN-3: the zcode hook entry is a plain `command` handler holding the registered string, no powershell prefix", () => {
  const reg = buildRegistry({ home: "C:\\Users\\Jane Doe", pkgDir: "C:\\Program Files\\nodejs\\node_modules\\context-mode", env: {} });
  const row = reg.find((r) => r.id === "zcode");
  const entries = commandEntries(row.hookInstall.shape);
  assert.ok(entries.length > 0);
  for (const e of entries) {
    assert.equal(e.type, "command");
    assert.equal(e.command, hookCommandString(row));
    assert.equal(e.powershell, undefined);
    assert.equal(e.shell, undefined, "no per-hook shell override: ZCode picks ComSpec on win32");
  }
});

// Windows only: spawn exactly as ZCode does, Node spawn with shell = ComSpec and the command string as the file.
test("Z-WIN-3: Node spawn with shell=ComSpec (as ZCode spawns a command hook) runs the registered zcode hook command", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "cm zc "));
  try {
    const dir = path.join(root, "pkg dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hook.mjs"), "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>process.stdout.write('ran:' + process.argv.slice(2).join(' ') + ':' + d));\n");
    const reg = buildRegistry({ home: root, pkgDir: dir, env: {} });
    const row = reg.find((r) => r.id === "zcode");
    const line = hookCommandString(row);
    const r = spawnSync(line, { shell: process.env.ComSpec || "cmd.exe", input: '{"x":1}', encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, "stderr=" + r.stderr + " stdout=" + r.stdout + " line=" + line);
    assert.equal(r.stdout.trim(), 'ran:--agent zcode:{"x":1}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
