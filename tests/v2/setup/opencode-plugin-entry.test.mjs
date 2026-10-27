// OC-WIN-4 (D-WIN-OCENTRY-1): the opencode plugin entry is the absolute path of opencode/plugin.js, written bare.
// OpenCode 1.19.4 (binary strings, resolver for config `plugin` entries): a value that is `file://`, starts with `.`,
// is absolute, or starts with a drive letter + `:` + `\` or `/` is a file entry, and an absolute or drive-letter
// value is turned into a file URL with pathToFileURL (so spaces and backslashes are encoded by OpenCode itself).
// Writing a file:// URL here would be a second spelling of the same entry. This test runs on every OS with fake
// Windows paths and fails if the entry stops being a plain absolute path under the package dir.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRegistry } from "../../../src/setup/index.ts";

const WIN_HOME = "C:\\Users\\Jane Doe";
const WIN_PKG = "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\context-mode";

function isDriveLetterPath(s) {
  const c = s.charCodeAt(0);
  const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return letter && s[1] === ":" && (s[2] === "\\" || s[2] === "/");
}

test("OC-WIN-4: the opencode plugin entry is a bare drive-letter path OpenCode's resolver accepts", () => {
  const row = buildRegistry({ home: WIN_HOME, pkgDir: WIN_PKG, env: {} }).find((r) => r.id === "opencode");
  assert.equal(row.hookInstall.kind, "plugin-list");
  const entry = row.hookInstall.entry;
  assert.ok(entry.startsWith(WIN_PKG), "entry is under the package dir: " + entry);
  assert.ok(entry.endsWith("plugin.js"), "entry names plugin.js: " + entry);
  assert.ok(isDriveLetterPath(entry), "entry is a drive-letter path: " + entry);
  assert.ok(!entry.startsWith("file:"), "no file URL spelling: " + entry);
});

test("OC-WIN-4: a POSIX package dir with a space stays a bare absolute path", () => {
  const pkg = "/Users/jane doe/.npm-global/lib/node_modules/context-mode";
  const row = buildRegistry({ home: "/Users/jane doe", pkgDir: pkg, env: {} }).find((r) => r.id === "opencode");
  assert.ok(row.hookInstall.entry.startsWith("/Users/jane doe/"), row.hookInstall.entry);
  assert.ok(!row.hookInstall.entry.startsWith("file:"));
});
