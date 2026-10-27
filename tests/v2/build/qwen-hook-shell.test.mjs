// Q-WIN-5 (D-WIN-QWEN-SHELL-1): how Qwen Code turns hooks/qwen.json into a process on Windows.
// Source read (qwen-code 0.26.2, chunk-2XNBZWKL): substituteHookVariables does a plain text swap of ${CLAUDE_PLUGIN_ROOT}
// with the extension path (path.join, so backslashes on Windows); no slash conversion. getShellConfiguration picks
// bash -c only when MSYSTEM/TERM says Git Bash, else ComSpec (cmd.exe /d /s /c, or PowerShell when ComSpec is one).
// In bash a backslash inside double quotes is kept unless it comes before $ ` " \ or newline, so a drive path survives.
// This test repeats the swap with fake Windows paths on every OS and runs real bash (Git Bash on Windows).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateManifests } from "../../../build/manifests.ts";

const VAR = "${CLAUDE_PLUGIN_ROOT}";
const hydrate = (s, root) => s.split(VAR).join(root);
const qwenCommands = (dir) => {
  const hooks = JSON.parse(readFileSync(path.join(dir, "hooks", "qwen.json"), "utf8")).hooks;
  const cmds = Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
  assert.ok(cmds.length > 0, "qwen hook file has commands");
  assert.equal(new Set(cmds).size, 1, "one command for every event");
  return cmds[0];
};
const gitBash = () => {
  if (process.platform !== "win32") return "bash";
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files"].filter(Boolean);
  return roots.map((r) => path.join(r, "Git", "bin", "bash.exe")).find((p) => existsSync(p));
};

test("Q-WIN-5: the qwen hook command, swapped with a Windows path, starts with node and quotes the spaced path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cm-qwen-shell-"));
  try {
    generateManifests(dir);
    const raw = qwenCommands(dir);
    assert.equal(raw.split("${").length - 1, 1, "the only placeholder is the one qwen replaces in hook commands");
    const ext = "C:\\Users\\Jane Doe\\.qwen\\extensions\\context-mode";
    const line = hydrate(raw, ext);
    assert.equal(line, 'node "' + ext + '/hook.mjs" --agent qwen');
    assert.ok(!line.startsWith('"'), "a leading quoted string is a PowerShell parse error (D-HW-PS-1)");
    assert.ok(!line.includes("${"), "no placeholder left for the shell to see");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// bash (Git Bash on Windows) must hand node the path byte for byte: spaces, a dot dir, drive letter, backslashes.
test("Q-WIN-5: bash -c keeps a backslashed, spaced Windows path inside the double quotes", { skip: gitBash() === undefined ? "no bash" : false }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cm-qwen-bash-"));
  try {
    generateManifests(dir);
    const ext = "C:\\Users\\Jane Doe\\.qwen\\extensions\\context-mode";
    const line = hydrate(qwenCommands(dir), ext);
    assert.ok(line.startsWith("node "));
    // Swap only the program: printf shows the one argument bash passes.
    const r = spawnSync(gitBash(), ["-c", "printf '%s' " + line.slice("node ".length).split(" --agent")[0]], { encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, ext + "/hook.mjs");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Real files: the shell qwen picks must start node on the stub with stdin intact. A real run on Windows covers Git Bash.
test("Q-WIN-5: bash -c starts node on a spaced extension dir and stdin reaches it", { skip: gitBash() === undefined ? "no bash" : false }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "cm qwen run "));
  try {
    const ext = path.join(root, "ext dir");
    mkdirSync(ext, { recursive: true });
    writeFileSync(path.join(ext, "hook.mjs"), "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>process.stdout.write('ran:' + process.argv.slice(2).join(' ') + ':' + d));\n");
    const out = mkdtempSync(path.join(root, "out "));
    generateManifests(out);
    const line = hydrate(qwenCommands(out), ext);
    const r = spawnSync(gitBash(), ["-c", line], { input: '{"x":1}', encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'ran:--agent qwen:{"x":1}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Windows only. Qwen's hookRunner (getShellConfiguration, no Git Bash env) runs spawn(ComSpec, ["/d","/s","/c", line],
// { shell: false }) with NO windowsVerbatimArguments, so Node re-quotes the whole line and escapes the inner quotes.
// This repeats that exact spawn on the real cmd.exe, with a spaced extension dir.
test("Q-WIN-5: cmd.exe /d /s /c, spawned the way qwen spawns it, runs the hydrated qwen hook command", { skip: process.platform !== "win32", todo: "KNOWN DEFECT Q-WIN-5 (D-WIN-QWEN-SHELL-1): Node escapes the inner quotes as \\\" and node.exe gets literal quote characters; needs a design decision, see OPEN-ITEMS" }, () => {
  const root = mkdtempSync(path.join(tmpdir(), "cm qwen cmd "));
  try {
    const ext = path.join(root, "ext dir");
    mkdirSync(ext, { recursive: true });
    writeFileSync(path.join(ext, "hook.mjs"), "let d='';process.stdin.on('data',(c)=>d+=c).on('end',()=>process.stdout.write('ran:' + process.argv.slice(2).join(' ') + ':' + d));\n");
    const out = mkdtempSync(path.join(root, "out "));
    generateManifests(out);
    const line = hydrate(qwenCommands(out), ext);
    const r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], { input: '{"x":1}', encoding: "utf8", shell: false, windowsHide: true });
    assert.equal(r.status, 0, "stderr=" + r.stderr + " stdout=" + r.stdout + " line=" + line);
    assert.equal(r.stdout.trim(), 'ran:--agent qwen:{"x":1}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
