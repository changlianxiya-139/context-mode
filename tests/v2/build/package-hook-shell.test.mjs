// Q-WIN-4 (D-WIN-PKGHOOK-1): the hook command a package channel ships (claude-code, qwen, gemini) must not start with
// a quoted string. Qwen Code runs a Windows hook under cmd by default and under PowerShell when the hook sets `shell`
// (qwen-code docs/users/features/hooks.md); Gemini always uses PowerShell. PowerShell reads a leading quoted string as
// an expression and fails to parse the rest. The shipped form is `node "<path>" --agent <id>`: valid in cmd, sh and
// PowerShell. Fake Windows values run on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateManifests } from "../../../build/manifests.ts";

const FILES = { "claude-code": "claude-code.json", qwen: "qwen.json", gemini: "hooks.json" };
const hydrate = (s, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.split("${" + k + "}").join(v), s);
const commands = (dir, file) => {
  const hooks = JSON.parse(readFileSync(path.join(dir, "hooks", file), "utf8")).hooks;
  return [...new Set(Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command))))];
};

test("Q-WIN-4: package hook commands start with bare node and quote the spaced path, hydrated with Windows values", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cm-pkg-shell-"));
  try {
    generateManifests(dir);
    const root = "C:\\Users\\Jane Doe\\.qwen\\extensions\\context-mode";
    for (const [id, file] of Object.entries(FILES)) {
      const cmds = commands(dir, file);
      assert.equal(cmds.length, 1, id + ": one command for every event");
      const line = hydrate(cmds[0], { CLAUDE_PLUGIN_ROOT: root, extensionPath: root, "/": "\\", pathSeparator: "\\" });
      assert.ok(line.startsWith("node "), id + ": first token is bare node: " + line);
      assert.ok(!line.includes("${"), id + ": no placeholder left for the shell to see");
      assert.ok(line.endsWith(" --agent " + id), id + ": " + line);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// CP-WIN-1 / VS-WIN-1 (D-WIN-FLATPKG-1): copilot-cli and vscode ship a flat shape (no nested hooks array). The shipped
// command is bare `node hook.mjs --agent <id>`: no quoted first token, so PowerShell parses it with no `&`.
test("CP-WIN-1, VS-WIN-1: shipped copilot-cli and vscode hook commands start with bare node (valid in PowerShell, cmd, sh)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cm-pkg-flat-"));
  try {
    generateManifests(dir);
    for (const id of ["copilot-cli", "vscode"]) {
      const hooks = JSON.parse(readFileSync(path.join(dir, "hooks", id + ".json"), "utf8")).hooks;
      const cmds = [...new Set(Object.values(hooks).flatMap((entries) => entries.map((h) => h.command)))];
      assert.equal(cmds.length, 1, id + ": one command for every event");
      assert.ok(cmds[0].startsWith("node "), id + ": first token is bare node: " + cmds[0]);
      assert.ok(!cmds[0].startsWith('"') && !cmds[0].includes("${"), id + ": no leading quote, no placeholder");
      assert.ok(cmds[0].endsWith(" --agent " + id), id + ": " + cmds[0]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
