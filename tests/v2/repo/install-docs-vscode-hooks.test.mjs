// tests/v2/repo/install-docs-vscode-hooks.test.mjs
// D-NI-VSCODE-DOC-1: setup writes the VS Code hooks to ~/.copilot/hooks/context-mode-vscode.json (src/adapters/table.ts
// hookChannel home-file, src/setup/hook-shapes.ts flatShape with "timeout"). The Known limits line said the opposite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { getAdapter } from "../../../src/adapters/table.ts";

const REPO = path.join(import.meta.dirname, "..", "..", "..");
const doc = readFileSync(path.join(REPO, "docs", "install", "vscode.md"), "utf8");
const limits = doc.split("## Known limits")[1]?.split("\n## ")[0] ?? "";

test("[D-NI-VSCODE-DOC-1] vscode.md does not say setup writes no hook file", () => {
  assert.ok(!doc.includes("Setup writes no hook file"), "stale line still in docs/install/vscode.md");
});

test("[D-NI-VSCODE-DOC-1] vscode.md Known limits names the hook file setup writes and its shape", () => {
  const ch = getAdapter("vscode").hookChannel;
  assert.equal(ch.kind, "home-file");
  const file = "~/" + ch.path;
  assert.ok(limits.includes(file), `Known limits must name ${file}`);
  for (const w of ["`version: 1`", "`type: \"command\"`", "`timeout`", "--agent vscode"]) assert.ok(limits.includes(w), `Known limits must name ${w}`);
});
