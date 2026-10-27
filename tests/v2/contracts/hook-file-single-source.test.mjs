// VS-WIN-6 / D-WIN-VSCODE-HOOKFILE-1: one hook file location per agent. ADAPTERS[].hookChannel (what setup writes,
// ADR-0020) and HOOK_HOST_FILE (what doctor D3 reads) must name the same file, on every OS.
// The test builds each expected path with path.join, so it holds on Windows and POSIX alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { ADAPTERS } from "../../../src/adapters/table.ts";
import { HOOK_HOST_FILE } from "../../../src/core/contracts/constants.ts";

const POSIX_SEP = "/";

test("HOOK_HOST_FILE agrees with every adapter hookChannel (root kind and file path)", () => {
  const kinds = { "home-file": "home", package: "plugin" };
  for (const row of ADAPTERS) {
    const spec = HOOK_HOST_FILE[row.id];
    const ch = row.hookChannel;
    if (ch.kind === "in-process") { assert.equal(spec, null, `${row.id}: in-process agent has no hook file`); continue; }
    assert.ok(spec !== null, `${row.id}: hook file row missing`);
    assert.equal(spec.root, kinds[ch.kind], `${row.id}: root ${spec.root} vs channel ${ch.kind}`);
    assert.equal(path.join(...spec.file), path.join(...ch.path.split(POSIX_SEP)), `${row.id}: doctor and setup name different hook files`);
  }
});

test("vscode: the hook file is the user file ~/.copilot/hooks/context-mode-vscode.json, never a project .github/hooks file", () => {
  // Documented (page fetched 2026-10-27): code.visualstudio.com/docs/copilot/customization/hooks, "Choose a hook source":
  // personal hooks = "User hook files in ~/.copilot/hooks/"; repo-shared = ".github/hooks/*.json". Setup writes the user
  // file only (docs/install/vscode.md), so doctor D3 must read that same file.
  const spec = HOOK_HOST_FILE.vscode;
  assert.equal(spec.root, "home");
  assert.deepEqual([...spec.file], [".copilot", "hooks", "context-mode-vscode.json"]);
});
