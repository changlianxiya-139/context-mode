// tests/v2/ops/host-text.test.mjs
// CC-WIN-3: BOM and CRLF in host config files. Runs on every OS (the bytes are built in the test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { hostLayout, hostText, withLayout } from "../../../src/core/ops/host-text.ts";
import { readHostConfig, writeHostConfigEdit } from "../../../src/core/ops/host-config.ts";
import { detectV1 } from "../../../src/core/ops/detect-v1.ts";
import { removeV1 } from "../../../src/core/ops/v1-remove.ts";
import { readUserDeny } from "../../../src/core/policy/user-deny.ts";

const BOM = "﻿";
function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "cm-host-text-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("host-text: layout is read, text is plain LF, layout comes back byte for byte", () => {
  const raw = BOM + '{\r\n  "a": 1\r\n}\r\n';
  assert.deepEqual(hostLayout(raw), { bom: true, crlf: true });
  assert.equal(hostText(raw), '{\n  "a": 1\n}\n');
  assert.equal(withLayout(hostText(raw), hostLayout(raw)), raw);
  assert.deepEqual(hostLayout('{"a":1}\n'), { bom: false, crlf: false });
  assert.equal(hostText('{"a":1}\n'), '{"a":1}\n');
  assert.equal(withLayout("x\n", { bom: false, crlf: false }), "x\n");
  assert.equal(hostText(""), "");
  assert.equal(hostText(BOM), "");
  assert.equal(hostText("a\rb"), "a\rb", "a lone CR stays");
  assert.equal(hostText("a" + BOM), "a" + BOM, "only a leading BOM goes");
});

test("host-text: readHostConfig strips a BOM and CRLF; writeHostConfigEdit keeps both", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "settings.json");
  const raw = BOM + '{\r\n  "model": "x"\r\n}\r\n';
  writeFileSync(file, raw, "utf8");
  const cur = readHostConfig("kiro", file);
  assert.equal(cur.text, '{\n  "model": "x"\n}\n');
  writeHostConfigEdit(file, cur, { extra: 1 });
  const out = readFileSync(file, "utf8");
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.equal(out.split("\r\n").join("").includes("\n"), false, "every line end is CRLF");
  assert.deepEqual(JSON.parse(out.slice(1)), { model: "x", extra: 1 });
});

test("host-text: detectV1 sees a v1 hook in a settings.json that starts with a BOM", (t) => {
  const home = tmp(t);
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude", "settings.json"), BOM + JSON.stringify({ mcpServers: { "context-mode": { command: "node" } } }, null, 2).split("\n").join("\r\n"), "utf8");
  assert.ok(detectV1("claude-code", home, { tmp: tmp(t) }).length > 0);
});

test("host-text: removeV1 edits a BOM + CRLF file and keeps its layout", (t) => {
  const home = tmp(t);
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  const file = path.join(home, ".claude", "settings.json");
  const doc = { model: "x", mcpServers: { "context-mode": { command: "node" } } };
  writeFileSync(file, BOM + JSON.stringify(doc, null, 2).split("\n").join("\r\n") + "\r\n", "utf8");
  const findings = detectV1("claude-code", home, { tmp: tmp(t) });
  const rm = removeV1("claude-code", findings);
  rm.commit();
  const out = readFileSync(file, "utf8");
  assert.equal(out.charCodeAt(0), 0xfeff);
  assert.equal(out.split("\r\n").join("").includes("\n"), false);
  assert.equal(JSON.parse(out.slice(1)).mcpServers["context-mode"], undefined);
  assert.equal(JSON.parse(out.slice(1)).model, "x");
});

test("host-text: readUserDeny reads deny rules from a settings.json with a BOM (not fail-closed null)", (t) => {
  const root = tmp(t);
  const home = path.join(root, "home");
  const proj = path.join(root, "proj");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(path.join(home, ".claude", "settings.json"), BOM + '{\r\n  "permissions": { "deny": ["Bash(sudo *)"] }\r\n}\r\n', "utf8");
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  assert.deepEqual(readUserDeny(proj, "claude-code"), ["Bash(sudo *)"]);
});
