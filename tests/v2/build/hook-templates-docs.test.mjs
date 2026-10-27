// D-FU-RM-TEMPLATES-1: codex, vscode and copilot-cli have no documented plugin-root variable, so the shipped
// hooks/<id>.json files are templates. The install docs one-line writer fills the path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../../../" + p, import.meta.url), "utf8");

for (const id of ["codex", "vscode", "copilot-cli"]) {
  test(`install guide ${id} says the shipped hook file is a template`, () => {
    const md = read(`docs/install/${id}.md`);
    assert.ok(md.includes(`the writer fills the path; do not copy hooks/${id}.json by hand`), `${id}.md lacks the template note`);
  });
}

test("impl/10-adapters.md marks the codex, vscode and copilot-cli hook files as templates", () => {
  const md = read("docs/v2/impl/10-adapters.md");
  assert.match(md, /Template hook files[^\n]*codex[^\n]*vscode[^\n]*copilot-cli/);
});

test("claude-code guide states the native marketplace command (ADR-0023) and the claude mcp add limit; LAUNCH keeps ADR-0011 step b", () => {
  const guide = read("docs/install/claude-code.md");
  assert.match(guide, /claude plugin marketplace add mksglu\/context-mode/, "guide: no native marketplace command");
  assert.match(guide, /claude mcp add/, "guide: no claude mcp add limit");
  const launch = read("docs/v2/LAUNCH.md");
  assert.match(launch, /ADR-0011 step b/, "LAUNCH: no ADR-0011 step b");
  assert.match(launch, /claude mcp add/, "LAUNCH: no claude mcp add fallback");
});
