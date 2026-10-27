// tests/v2/setup/doctor-hook-runs.test.mjs
// Spec: docs/v2/OPEN-ITEMS.md H5, docs/v2/adr/0020-hooks-and-skills-on-every-agent.md (saving effect per host).
// Doctor hook-runs sends one large shell read, in the host's own wire shape, through the installed hook bundle. It
// passes only when the answer is that host's saving effect (deny + ctx_execute redirect, or replace + ctx_search
// line) with the project resolved. A silent hook or a NO_PROJECT hook was a false PASS before: pi before
// D-HA-PI-PROJECT-1 and vscode before D-HF-VSCODE-PROJECT-1 both answered nothing and doctor said PASS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ADAPTERS } from "../../../src/adapters/table.ts";
import { buildRegistry, hookRunsCheck } from "../../../src/setup/index.ts";

const REPO = path.resolve(import.meta.dirname, "../../..");
// The real hook entry stands in for the built bundle: same code path as <pkgDir>/hook.mjs after a build.
const REAL_HOOK = `import ${JSON.stringify(pathToFileURL(path.join(REPO, "src", "entries", "hook.ts")).href)};\n`;
const SILENT_HOOK = `process.stdin.resume(); process.stdin.on("end", () => {});\n`;
// The exact line dispatch step 3 writes when resolveProject throws (D-FU-PS-1), then an allow (no answer).
const NO_PROJECT_HOOK = `process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write("hooks: no project: NO_PROJECT no project root\\n"); });\n`;

function sandbox(t, hookSrc) {
  const root = mkdtempSync(path.join(tmpdir(), "cm-hook-runs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const pkgDir = path.join(root, "pkg");
  mkdirSync(home, { recursive: true });
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "hook.mjs"), hookSrc);
  const win = process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {};
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...win };
  return { home, env, reg: buildRegistry({ home, pkgDir, env }) };
}

test("H5: doctor hook-runs PASSES on all 10 hosts with the real hook: the large shell read gets the saving effect", (t) => {
  const s = sandbox(t, REAL_HOOK);
  assert.equal(s.reg.length, ADAPTERS.length);
  assert.equal(s.reg.length, 10);
  for (const row of s.reg) {
    const c = hookRunsCheck(row, s.env);
    assert.equal(c.name, "hook-runs", row.id);
    assert.equal(c.ok, true, row.id + ": " + c.detail);
  }
  // Doctor is read-only: the sample runs in its own temp HOME, never in the user's store.
  assert.equal(existsSync(path.join(s.home, ".context-mode")), false, "doctor wrote into HOME/.context-mode");
});

test("H5: doctor hook-runs FAILS on every host when the hook answers nothing (no saving decision)", (t) => {
  const s = sandbox(t, SILENT_HOOK);
  for (const row of s.reg) {
    const c = hookRunsCheck(row, s.env);
    assert.equal(c.ok, false, row.id + " a silent hook is a false PASS");
    assert.ok(c.detail.includes("no saving decision"), row.id + ": " + c.detail);
  }
});

test("H5: doctor hook-runs FAILS on every host when the hook cannot resolve the project (NO_PROJECT)", (t) => {
  const s = sandbox(t, NO_PROJECT_HOOK);
  for (const row of s.reg) {
    const c = hookRunsCheck(row, s.env);
    assert.equal(c.ok, false, row.id + " a NO_PROJECT hook is a false PASS");
    assert.ok(c.detail.includes("NO_PROJECT"), row.id + ": " + c.detail);
  }
});
