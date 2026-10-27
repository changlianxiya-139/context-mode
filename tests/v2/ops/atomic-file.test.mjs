// tests/v2/ops/atomic-file.test.mjs
// DEVIATIONS D-WIN-ATOMIC-1: on Windows a rename over a file another process holds open (host watching
// settings.json, antivirus, indexer) fails with EPERM/EBUSY/EACCES. renameWithRetry retries; atomicWriteFile
// removes its tmp file on failure and names the file to free. Fake platform + injected rename: runs on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { atomicWriteFile, renameWithRetry, unlinkWithRetry } from "../../../src/core/ops/atomic-file.ts";
import { ATOMIC_RENAME_RETRIES } from "../../../src/core/contracts/constants.ts";

function tmp(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "cm-atomic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function failing(code, times, real) {
  const calls = { n: 0 };
  const rename = (a, b) => {
    calls.n += 1;
    if (calls.n <= times) throw Object.assign(new Error(`${code}: busy, rename`), { code });
    real(a, b);
  };
  return { calls, rename };
}
const noSleep = () => {};

test("[win] atomic-file/rename-retries-EPERM-twice-then-succeeds", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "settings.json");
  writeFileSync(file, "old");
  writeFileSync(file + ".new", "new");
  const { calls, rename } = failing("EPERM", 2, (a, b) => renameWithRetry(a, b, { platform: "linux" }));
  renameWithRetry(file + ".new", file, { platform: "win32", rename, sleep: noSleep });
  assert.equal(calls.n, 3);
  assert.equal(readFileSync(file, "utf8"), "new");
});

test("[win] atomic-file/rename-retries-EBUSY-and-EACCES", () => {
  for (const code of ["EBUSY", "EACCES"]) {
    const { calls, rename } = failing(code, 1, () => {});
    renameWithRetry("a", "b", { platform: "win32", rename, sleep: noSleep });
    assert.equal(calls.n, 2, code);
  }
});

test("[win] atomic-file/rename-does-not-retry-on-posix-or-other-codes", () => {
  const a = failing("EPERM", 9, () => {});
  assert.throws(() => renameWithRetry("a", "b", { platform: "linux", rename: a.rename, sleep: noSleep }), /EPERM/);
  assert.equal(a.calls.n, 1);
  const b = failing("ENOENT", 9, () => {});
  assert.throws(() => renameWithRetry("a", "b", { platform: "win32", rename: b.rename, sleep: noSleep }), /ENOENT/);
  assert.equal(b.calls.n, 1);
});

test("[win] atomic-file/rename-gives-up-after-the-retry-budget", () => {
  const { calls, rename } = failing("EBUSY", 99, () => {});
  const slept = [];
  assert.throws(() => renameWithRetry("a", "b", { platform: "win32", rename, sleep: (ms) => slept.push(ms) }), /EBUSY/);
  assert.equal(calls.n, ATOMIC_RENAME_RETRIES + 1);
  assert.equal(slept.length, ATOMIC_RENAME_RETRIES);
});

test("[win] atomic-file/write-succeeds-after-two-failed-renames-and-leaves-no-tmp", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "sub", "settings.json");
  const { calls, rename } = failing("EPERM", 2, (a, b) => renameWithRetry(a, b, { platform: "linux" }));
  atomicWriteFile(file, "{}", { platform: "win32", rename, sleep: noSleep });
  assert.equal(calls.n, 3);
  assert.equal(readFileSync(file, "utf8"), "{}");
  assert.deepEqual(readdirSync(path.dirname(file)), ["settings.json"]);
});

test("[win] atomic-file/write-failure-removes-tmp-keeps-old-file-and-says-close-the-program", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "settings.json");
  writeFileSync(file, "old");
  const { rename } = failing("EBUSY", 99, () => {});
  assert.throws(
    () => atomicWriteFile(file, "new", { platform: "win32", rename, sleep: noSleep }),
    (e) => e.message.includes(file) && e.message.includes("Fix: close the program using") && e.message.includes("EBUSY"),
  );
  assert.equal(readFileSync(file, "utf8"), "old");
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
  assert.equal(existsSync(file + ".tmp"), false);
});

test("[win] atomic-file/posix-write-failure-also-removes-tmp", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "a.json");
  const { rename } = failing("EACCES", 99, () => {});
  assert.throws(() => atomicWriteFile(file, "x", { platform: "linux", rename, sleep: noSleep }), /EACCES/);
  assert.deepEqual(readdirSync(dir), []);
});

// Guard: the file replace sites go through the one helper, not a bare renameSync (no regex: plain string search).
test("[win] atomic-file/no-bare-renameSync-at-the-file-replace-sites", () => {
  for (const f of ["src/setup/engine.ts", "src/core/ops/host-write.ts", "src/core/ops/host-config.ts", "src/core/ops/v1-remove.ts", "src/core/ops/db-heal.ts"]) {
    assert.equal(readFileSync(path.join(import.meta.dirname, "../../..", f), "utf8").includes("renameSync("), false, f);
  }
});

// Q-WIN-1 / D-WIN-ATOMIC-4: rollback removes a file the setup created. On Windows that unlink fails with
// EPERM/EBUSY while the host holds the file open, so it retries like the rename does.
test("[win] atomic-file/unlink-retries-EBUSY-twice-then-succeeds", () => {
  let n = 0;
  const unlink = () => { n += 1; if (n <= 2) throw Object.assign(new Error("EBUSY: busy, unlink"), { code: "EBUSY" }); };
  unlinkWithRetry("C:\\x\\settings.json", { platform: "win32", unlink, sleep: noSleep });
  assert.equal(n, 3);
});

test("[win] atomic-file/unlink-does-not-retry-on-posix-and-names-the-file-when-it-gives-up", () => {
  let n = 0;
  const unlink = () => { n += 1; throw Object.assign(new Error("EPERM: busy, unlink"), { code: "EPERM" }); };
  assert.throws(() => unlinkWithRetry("/x/settings.json", { platform: "linux", unlink, sleep: noSleep }), /Could not replace \/x\/settings\.json.*close the program/);
  assert.equal(n, 1);
  n = 0;
  assert.throws(() => unlinkWithRetry("C:\\x\\s.json", { platform: "win32", unlink, sleep: noSleep }), /close the program using C:\\x\\s\.json/);
  assert.equal(n, ATOMIC_RENAME_RETRIES + 1);
});

test("[win] atomic-file/unlink-of-a-missing-file-is-not-an-error", () => {
  const unlink = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  unlinkWithRetry("/x/gone.json", { platform: "win32", unlink, sleep: noSleep });
});

test("[win] atomic-file/setup-rollback-has-no-bare-unlinkSync", () => {
  assert.equal(readFileSync(path.join(import.meta.dirname, "../../..", "src/setup/engine.ts"), "utf8").includes("unlinkSync("), false);
});
