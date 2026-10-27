// tests/v2/setup/codex-trust-key.test.mjs
// D-WIN-CODEX-KEY-1: the [hooks.state."<key>"] key must equal the `key` Codex prints in hooks/list. Probed on Codex 0.156.1:
// the default ~/.codex is used as spelled (a symlinked HOME is not resolved); $CODEX_HOME is canonicalised; the key is
// <codexHome>/hooks.json, and `codex app-server` initialize reports that codexHome. On Windows Codex may spell it
// with a \\?\ prefix or another drive-letter case, so setup asks Codex instead of computing the form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { codexHomeFromReply, codexKeyDir, codexTrustEntries } from "../../../src/setup/codex-trust.ts";

const DOC = { hooks: { PreToolUse: [{ matcher: "x", hooks: [{ type: "command", command: "cmd-a" }] }] } };
const keyOf = (entries) => entries[0][0][2];

function tmp(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cm-codex-key-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("D-WIN-CODEX-KEY-1: codexHomeFromReply reads codexHome from the initialize reply and ignores other lines", () => {
  const out = '{"method":"x","params":{}}\n{"id":1,"result":{"codexHome":"\\\\\\\\?\\\\C:\\\\Users\\\\x\\\\.codex"}}\nnot json\n';
  assert.equal(codexHomeFromReply(out), "\\\\?\\C:\\Users\\x\\.codex");
  assert.equal(codexHomeFromReply("garbage\n"), undefined);
  assert.equal(codexHomeFromReply('{"id":1,"result":{}}\n'), undefined);
});

test("D-WIN-CODEX-KEY-1: windows: the dir Codex reports (\\\\?\\ prefix, other case) is the key dir when it is our dir", () => {
  const real = (p) => p;
  const asked = "\\\\?\\C:\\Users\\X\\.codex";
  assert.equal(codexKeyDir({ dir: "c:\\users\\x\\.codex", asked, real }, "win32"), asked);
  assert.equal(codexKeyDir({ dir: "C:\\Users\\x\\.codex\\", asked: "C:\\Users\\X\\.codex", real }, "win32"), "C:\\Users\\X\\.codex");
});

test("D-WIN-CODEX-KEY-1: windows: a dir Codex reports that is not our dir is not used", () => {
  const real = (p) => p;
  assert.equal(codexKeyDir({ dir: "C:\\home a\\.codex", asked: "C:\\home b\\.codex", real }, "win32"), "C:\\home a\\.codex");
});

test("D-WIN-CODEX-KEY-1: no Codex answer: the real path of our dir (D-HA-CODEX-TRUST-1)", () => {
  const real = (p) => p.replace("link", "real");
  assert.equal(codexKeyDir({ dir: "/h/link/.codex", real }, "linux"), "/h/real/.codex");
});

test("D-WIN-CODEX-KEY-1: the codexHome that `codex app-server` reports is the key dir", { skip: process.platform === "win32" && "fake codex is an sh script" }, (t) => {
  const root = tmp(t);
  const dir = path.join(root, "home", ".codex");
  mkdirSync(dir, { recursive: true });
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const reply = JSON.stringify({ id: 1, result: { codexHome: dir } });
  writeFileSync(path.join(bin, "codex"), `#!/bin/sh\ncat >/dev/null\necho '${reply}'\n`);
  chmodSync(path.join(bin, "codex"), 0o755);
  const entries = codexTrustEntries(path.join(dir, "hooks.json"), DOC, "cmd-a", { PATH: `${bin}:/usr/bin:/bin` });
  assert.equal(keyOf(entries), `${path.join(dir, "hooks.json")}:pre_tool_use:0:0`);
});

// Only a real Windows run proves the cmd.exe shim spawn, the \\?\ spelling and the TOML key escape together.
test("D-WIN-CODEX-KEY-1: windows only: a codex.cmd shim's codexHome spelling is the key dir", { skip: process.platform !== "win32" && "needs cmd.exe" }, (t) => {
  const root = tmp(t);
  const dir = path.join(root, "home dir", ".codex");
  mkdirSync(dir, { recursive: true });
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const asked = "\\\\?\\" + dir;
  writeFileSync(path.join(bin, "codex.cmd"), `@echo ${JSON.stringify({ id: 1, result: { codexHome: asked } })}\r\n`);
  const env = { PATH: bin, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  const entries = codexTrustEntries(path.join(dir, "hooks.json"), DOC, "cmd-a", env);
  assert.equal(keyOf(entries), `${asked}\\hooks.json:pre_tool_use:0:0`);
});
