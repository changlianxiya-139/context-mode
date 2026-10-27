// GEM-WIN-5 (D-WIN-GEMINI-SHELL-1): how Gemini CLI turns hooks/hooks.json into a process on Windows.
// Source read (gemini-cli 0.26.0 and 0.65.0): extension-manager loadExtensionHooks runs hydrateString over every string
// with { extensionPath, workspacePath, "/": path.sep, pathSeparator: path.sep }, so ${extensionPath} and ${/} are
// expanded in a hook command. hookRunner then spawns `powershell.exe -NoProfile -Command <command>` on Windows
// (ComSpec is only read to pick pwsh/powershell), never cmd.exe. This test repeats that hydration (split/join, same
// replace-only-known-keys rule) with fake Windows paths on every OS, and runs the real powershell.exe on Windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateManifests } from "../../../build/manifests.ts";

const hydrate = (s, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.split("${" + k + "}").join(v), s);
const geminiCommand = (dir) => {
  const hooks = JSON.parse(readFileSync(path.join(dir, "hooks", "hooks.json"), "utf8")).hooks;
  const cmds = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  assert.ok(cmds.length > 0, "gemini hook file has commands");
  assert.equal(new Set(cmds).size, 1, "one command for every event");
  return cmds[0];
};

test("GEM-WIN-5: the gemini hook command, hydrated with Windows values, starts with node and quotes the spaced path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cm-gem-shell-"));
  try {
    generateManifests(dir);
    const ext = "C:\\Users\\Jane Doe\\.gemini\\extensions\\context-mode";
    const line = hydrate(geminiCommand(dir), { extensionPath: ext, "/": "\\", pathSeparator: "\\" });
    assert.equal(line, 'node "' + ext + '\\hook.mjs" --agent gemini');
    assert.ok(!line.startsWith('"'), "a leading quoted string is a PowerShell parse error (D-HW-PS-1)");
    assert.ok(!line.includes("${"), "no placeholder left for the shell to see");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Only a real Windows run proves the PowerShell parse of the spaced, backslash path.
test("GEM-WIN-5: Windows PowerShell, the shell Gemini uses, runs the hydrated gemini hook command", { skip: process.platform !== "win32" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "cm gem ps "));
  try {
    const ext = path.join(root, "ext dir");
    mkdirSync(ext, { recursive: true });
    writeFileSync(path.join(ext, "hook.mjs"), "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>process.stdout.write('ran:' + process.argv.slice(2).join(' ') + ':' + d));\n");
    const out = mkdtempSync(path.join(root, "out "));
    generateManifests(out);
    const line = hydrate(geminiCommand(out), { extensionPath: ext, "/": path.sep, pathSeparator: path.sep });
    // Same wrapper Gemini adds so a non-zero exit of the native command is kept.
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", line + "; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"], { input: '{"x":1}', encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'ran:--agent gemini:{"x":1}', "stdin reaches the native command through -Command");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
