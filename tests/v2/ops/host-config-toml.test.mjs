// tests/v2/ops/host-config-toml.test.mjs
// Tester report 2.0.0-next.6: the Codex setup rejected valid TOML (multiline strings, multiline arrays,
// [[skills.config]]). Contract: every valid TOML 1.0 file is read, our own table and keys are edited, and every
// other byte of the file stays. D-TOML-PARSER-1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseTOML, getStaticTOMLValue } from "toml-eslint-parser";

import { editHostConfigText, hostConfigValueAt, mergeOwnEntries, parseHostConfig, tomlTableSpans } from "../../../src/core/ops/host-config.ts";
import { hostLayout, hostText, withLayout } from "../../../src/core/ops/host-text.ts";
import { detectV1 } from "../../../src/core/ops/detect-v1.ts";
import { removeV1 } from "../../../src/core/ops/v1-remove.ts";
import { checkHostConfig } from "../../../src/core/ops/doctor-config.ts";
import { getAdapter } from "../../../src/adapters/table.ts";
import { OWN_TABLE, TOML_FIXTURES, WITH_OWN } from "./toml-fixtures.mjs";

const row = getAdapter("codex");
const OWN_KEY = ["mcp_servers", "context-mode"];

const oracle = parseTOML; // independent of host-config.ts: the parser the production code is built on, used as a validator
const valueOf = (text) => getStaticTOMLValue(oracle(text));
const without = (value, key) => {
  const copy = structuredClone(value);
  let cur = copy;
  for (const seg of key.slice(0, -1)) cur = cur?.[seg];
  if (cur !== undefined) delete cur[key[key.length - 1]];
  if (copy.mcp_servers && Object.keys(copy.mcp_servers).length === 0) delete copy.mcp_servers;
  return copy;
};
const countHeader = (text, header) => text.split("\n").filter((l) => l.trim() === header).length;

function tmp(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "cm-toml-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// python3 tomllib is a second, unrelated TOML 1.0 parser; used when the machine has one.
function pythonParses(text) {
  for (const bin of ["python3", "python"]) {
    const r = spawnSync(bin, ["-c", "import sys,tomllib;tomllib.loads(sys.stdin.buffer.read().decode('utf-8-sig'))"], { input: text, encoding: "utf8", windowsHide: true });
    if (r.error) continue;
    return r.status === 0;
  }
  return undefined;
}

for (const [name, original] of Object.entries(TOML_FIXTURES)) {
  test(`[toml] ${name}: parseHostConfig accepts it and returns the value the oracle parser returns`, () => {
    const parsed = parseHostConfig("codex", "config.toml", original, "toml");
    assert.deepEqual(parsed, valueOf(original));
  });

  test(`[toml] ${name}: merge adds our table once, keeps every user key and byte, and a second merge changes nothing`, () => {
    const first = mergeOwnEntries("codex", original, "toml", row);
    assert.ok(first.edits.length > 0);
    const value = valueOf(first.text); // throws when the output is not valid TOML
    assert.equal(pythonParses(first.text) ?? true, true, "python tomllib parses the output");
    assert.equal(typeof value.mcp_servers["context-mode"].command, "string");
    assert.deepEqual(without(value, OWN_KEY), without(valueOf(original), OWN_KEY), "user keys unchanged");
    assert.equal(countHeader(first.text, OWN_TABLE), countHeader(original, OWN_TABLE) + 1, "our table present once (a header-like line inside a user string is not a table)");
    assert.equal(Object.keys(value.mcp_servers).filter((k) => k === "context-mode").length, 1);
    assert.ok(first.text.startsWith(original), "every original byte is still there, ahead of our appended table");
    const second = mergeOwnEntries("codex", first.text, "toml", row);
    assert.deepEqual(second.edits, []);
    assert.equal(second.text, first.text);
  });

  test(`[toml] ${name}: CRLF and BOM files round trip through the host layout`, () => {
    for (const layout of [{ bom: false, crlf: true }, { bom: true, crlf: false }, { bom: true, crlf: true }]) {
      const raw = withLayout(original, layout);
      assert.deepEqual(hostLayout(raw), original.includes("\n") || !layout.crlf ? layout : { ...layout, crlf: false });
      const first = mergeOwnEntries("codex", hostText(raw), "toml", row);
      const back = withLayout(first.text, hostLayout(raw));
      assert.ok(back.startsWith(raw), "original bytes kept, BOM and line ends included");
      const value = valueOf(hostText(back));
      assert.equal(value.mcp_servers["context-mode"].command.length > 0, true);
      assert.equal(mergeOwnEntries("codex", hostText(back), "toml", row).edits.length, 0);
    }
  });
}

test("[toml] an existing own table is replaced in place; comments and tables around it keep their bytes", () => {
  const { before, table, after } = WITH_OWN;
  const original = before + table + after;
  const out = mergeOwnEntries("codex", original, "toml", row);
  assert.ok(out.text.startsWith(before), "text before the table");
  assert.ok(out.text.endsWith(after), "text after the table (a comment ahead of the next table stays)");
  const middle = out.text.slice(before.length, out.text.length - after.length);
  assert.ok(middle.startsWith(OWN_TABLE + "\n"));
  assert.ok(!middle.includes("old-node"));
  assert.equal(countHeader(out.text, OWN_TABLE), 1);
  assert.deepEqual(without(valueOf(out.text), OWN_KEY), without(valueOf(original), OWN_KEY));
});

test("[toml] our table written as dotted keys or sub-tables is replaced as one table, not duplicated", () => {
  const dotted = `model = "o3"\nmcp_servers.context-mode.command = "old"\nmcp_servers.other.command = "o"\n\n[features]\nhooks = true\n`;
  const out = mergeOwnEntries("codex", dotted, "toml", row);
  const value = valueOf(out.text);
  assert.equal(value.mcp_servers.other.command, "o");
  assert.notEqual(value.mcp_servers["context-mode"].command, "old");
  assert.equal(value.features.hooks, true);
  const sub = `[mcp_servers.context-mode]\ncommand = "old"\n\n[mcp_servers.context-mode.env]\nK = "v"\n\n[tui]\ntheme = "dark"\n`;
  const out2 = mergeOwnEntries("codex", sub, "toml", row);
  const v2 = valueOf(out2.text);
  assert.deepEqual(v2.mcp_servers["context-mode"].env, { K: "v" }, "the user's env sub-table survives");
  assert.equal(v2.tui.theme, "dark");
  assert.equal(countHeader(out2.text, OWN_TABLE), 1);
});

test("[toml] hook trust tables are added beside arrays of tables and multiline strings", () => {
  const original = TOML_FIXTURES["multiline basic string"] + "\n[[skills.config]]\npath = \"/a\"\nenabled = true\n";
  const key = "/h/.codex/hooks.json:pre_tool_use:0:0";
  const out = editHostConfigText("codex", "config.toml", original, "toml", [[["hooks", "state", key], { trusted_hash: "sha256:abc" }]]);
  const value = valueOf(out.text);
  assert.deepEqual(value.hooks.state[key], { trusted_hash: "sha256:abc" });
  assert.deepEqual(value.skills.config, valueOf(original).skills.config);
  assert.ok(out.text.startsWith(original));
});

test("[toml] a file that is not TOML is CONFIG_PARSE_FAILED, never rewritten", () => {
  for (const bad of ["a = 1\na = 2\n", "[unclosed\nx = 1\n", "x = \"\"\"never closed\n", "x = [1, 2\n", "= 1\n"]) {
    assert.throws(() => parseHostConfig("codex", "c.toml", bad, "toml"), (e) => e.code === "CONFIG_PARSE_FAILED");
    assert.throws(() => mergeOwnEntries("codex", bad, "toml", row), (e) => e.code === "CONFIG_PARSE_FAILED");
  }
});

test("[toml] tomlTableSpans: header, path and line span of each table, a multiline-string line is not a header", () => {
  const text = TOML_FIXTURES["multiline basic string"] + "\n[ mcp_servers . \"context-mode\" ] # spaced\ncommand = \"n\"\n";
  const spans = tomlTableSpans(text);
  assert.deepEqual(spans.map((s) => s.path), [["features"], ["mcp_servers", "context-mode"]]);
  const own = spans[1];
  assert.equal(own.header, "[ mcp_servers . \"context-mode\" ] # spaced");
  assert.equal(text.slice(own.start, own.end), own.header + "\ncommand = \"n\"\n");
});

test("[toml] ctx_upgrade: v1 section detection and removal read real tables, not lines of a multiline string", (t) => {
  const home = tmp(t);
  const file = path.join(home, ".codex", "config.toml");
  mkdirSync(path.dirname(file), { recursive: true });
  const original =
    `notes = """\n[mcp_servers.context-mode]\n[not a header]\n"""\n\n[ mcp_servers . "context-mode" ]\ncommand = "context-mode"\nargs = [\n  "[x]",\n]\ndoc = """\n[tui]\n"""\n\n# keep\n[[skills.config]]\npath = "/a"\nenabled = true\n`;
  writeFileSync(file, original);
  const findings = detectV1("codex", home, { tmp: tmp(t) });
  const toml = findings.filter((f) => f.file === file);
  assert.equal(toml.length, 1, "only the real table is a finding");
  const r = removeV1("codex", findings);
  const after = readFileSync(file, "utf8");
  r.commit();
  const value = valueOf(after);
  assert.equal(value.mcp_servers, undefined, "the v1 table is gone with its multiline string");
  assert.equal(value.notes, "[mcp_servers.context-mode]\n[not a header]\n", "the user's string is untouched");
  assert.deepEqual(value.skills.config, [{ path: "/a", enabled: true }]);
  assert.ok(after.includes("# keep\n[[skills.config]]"));
});

test("[toml] doctor reads what setup wrote: the same reader on multiline, array-of-tables and CRLF files", (t) => {
  const home = tmp(t);
  const file = path.join(home, ".codex", "config.toml");
  mkdirSync(path.dirname(file), { recursive: true });
  for (const name of ["multiline basic string", "array of tables", "multiline array"]) {
    const merged = mergeOwnEntries("codex", TOML_FIXTURES[name], "toml", row).text;
    writeFileSync(file, withLayout(merged, { bom: true, crlf: true }));
    const d3 = checkHostConfig(row, { HOME: home }, home);
    assert.ok(!String(d3.detail).includes("parse") && !String(d3.detail).includes("unreadable"), `${name}: ${d3.detail}`);
    assert.notEqual(hostConfigValueAt(parseHostConfig("codex", file, merged, "toml"), OWN_KEY), undefined);
  }
});
