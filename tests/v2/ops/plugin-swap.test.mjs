// tests/v2/ops/plugin-swap.test.mjs
// Spec: docs/v2/impl/07-tools-ops.md §6 step 4c-4d; DEVIATIONS D-M5-U1-6 (current.swap symlink, then rename),
// D-M5-U4-1 (signature, which dirs count as a generation), D-M7-W3-1 (current -> current.old, current.swap -> current:
// Windows cannot rename a link over a dir link).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { swapPluginCurrent } from "../../../src/core/ops/plugin-swap.ts";
import { CtxError } from "../../../src/core/contracts/errors.ts";

function agentDir(t) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-plugin-swap-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function version(dir, sha) {
  mkdirSync(path.join(dir, sha), { recursive: true });
  writeFileSync(path.join(dir, sha, "server.bundle.mjs"), sha, "utf8");
}
const current = (dir) => path.join(dir, "current");
// D-WIN-JUNCTION-1: POSIX stores the bare sha, a Windows junction stores the absolute <dir>/<sha>.
const linkText = (dir, sha) => (process.platform === "win32" ? path.join(dir, sha) : sha);

test("[M5] plugin-swap/first-install-creates-current-link", (t) => {
  const dir = agentDir(t);
  version(dir, "aaa");
  const r = swapPluginCurrent(dir, "aaa");
  assert.ok(lstatSync(current(dir)).isSymbolicLink());
  assert.equal(realpathSync(current(dir)), path.join(dir, "aaa"));
  assert.deepEqual(r, { current: path.join(dir, "aaa"), previous: null, removed: [] });
  assert.equal(existsSync(path.join(dir, "current.swap")), false);
});

test("[M5] plugin-swap/second-upgrade-keeps-one-rollback-generation", (t) => {
  const dir = agentDir(t);
  version(dir, "aaa");
  swapPluginCurrent(dir, "aaa");
  version(dir, "bbb");
  const r = swapPluginCurrent(dir, "bbb");
  assert.equal(realpathSync(current(dir)), path.join(dir, "bbb"));
  assert.equal(r.previous, path.join(dir, "aaa"));
  assert.ok(existsSync(path.join(dir, "aaa")), "previous dir is kept on disk");
  assert.deepEqual(r.removed, []);
});

test("[M5] plugin-swap/third-upgrade-deletes-the-generation-two-back", (t) => {
  const dir = agentDir(t);
  for (const sha of ["aaa", "bbb", "ccc"]) { version(dir, sha); swapPluginCurrent(dir, sha); }
  assert.equal(realpathSync(current(dir)), path.join(dir, "ccc"));
  assert.ok(existsSync(path.join(dir, "bbb")));
  assert.equal(existsSync(path.join(dir, "aaa")), false);
});

test("[M5] plugin-swap/rollback-is-a-swap-to-the-previous-sha", (t) => {
  const dir = agentDir(t);
  for (const sha of ["aaa", "bbb"]) { version(dir, sha); swapPluginCurrent(dir, sha); }
  const r = swapPluginCurrent(dir, "aaa");
  assert.equal(realpathSync(current(dir)), path.join(dir, "aaa"));
  assert.equal(r.previous, path.join(dir, "bbb"));
  assert.ok(existsSync(path.join(dir, "bbb")), "the rolled-back-from dir stays as the rollback generation");
});

test("[M5] plugin-swap/same-sha-is-a-no-op-and-keeps-the-rollback", (t) => {
  const dir = agentDir(t);
  for (const sha of ["aaa", "bbb"]) { version(dir, sha); swapPluginCurrent(dir, sha); }
  const r = swapPluginCurrent(dir, "bbb");
  assert.deepEqual(r, { current: path.join(dir, "bbb"), previous: null, removed: [] });
  assert.ok(existsSync(path.join(dir, "aaa")));
});

test("[M5] plugin-swap/fetch-dirs-and-stale-swap-link-are-not-generations", (t) => {
  const dir = agentDir(t);
  for (const sha of ["aaa", "bbb"]) { version(dir, sha); swapPluginCurrent(dir, sha); }
  mkdirSync(path.join(dir, ".fetch-123"));
  symlinkSync("aaa", path.join(dir, "current.swap"), "dir");
  version(dir, "ccc");
  const r = swapPluginCurrent(dir, "ccc");
  assert.ok(existsSync(path.join(dir, ".fetch-123")), "an in-flight fetch dir is not touched");
  assert.equal(existsSync(path.join(dir, "current.swap")), false);
  assert.deepEqual(r.removed, [path.join(dir, "aaa")]);
  assert.equal(readlinkSync(current(dir)), linkText(dir, "ccc"));
});

test("[M5] plugin-swap/missing-new-dir-throws-and-leaves-current-alone", (t) => {
  const dir = agentDir(t);
  version(dir, "aaa");
  swapPluginCurrent(dir, "aaa");
  assert.throws(() => swapPluginCurrent(dir, "zzz"), (e) => e instanceof CtxError && e.code === "PLUGIN_ROOT_MISSING");
  assert.equal(realpathSync(current(dir)), path.join(dir, "aaa"));
});

test("[M7] plugin-swap/no-current-old-left-after-a-swap", (t) => {
  const dir = agentDir(t);
  for (const sha of ["aaa", "bbb"]) { version(dir, sha); swapPluginCurrent(dir, sha); }
  assert.equal(existsSync(path.join(dir, "current.old")), false);
  assert.equal(lstatSync(path.join(dir, "current.old"), { throwIfNoEntry: false }), undefined);
});

test("[M7] plugin-swap/a-stop-between-the-two-renames-is-undone-by-the-next-call", (t) => {
  const dir = agentDir(t);
  for (const sha of ["aaa", "bbb"]) { version(dir, sha); swapPluginCurrent(dir, sha); }
  // State after a stop between rename(current, current.old) and rename(current.swap, current).
  unlinkSync(current(dir));
  symlinkSync("bbb", path.join(dir, "current.old"), "dir");
  symlinkSync("ccc", path.join(dir, "current.swap"), "dir");
  version(dir, "ccc");
  const r = swapPluginCurrent(dir, "ccc");
  assert.equal(readlinkSync(current(dir)), linkText(dir, "ccc"));
  assert.equal(r.previous, path.join(dir, "bbb"), "the old link was put back first, so bbb is the rollback generation");
  assert.deepEqual(r.removed, [path.join(dir, "aaa")]);
  assert.equal(lstatSync(path.join(dir, "current.old"), { throwIfNoEntry: false }), undefined);
  assert.equal(lstatSync(path.join(dir, "current.swap"), { throwIfNoEntry: false }), undefined);
});

// DEVIATIONS D-WIN-ATOMIC-2: on Windows a rename of `current` / `current.swap` fails with EPERM when the host or
// antivirus holds a handle inside it. Fake platform + injected rename: runs on every OS.
test("[win] plugin-swap/retries-EPERM-on-link-rename-then-swaps", (t) => {
  const dir = agentDir(t);
  version(dir, "aaa");
  swapPluginCurrent(dir, "aaa");
  version(dir, "bbb");
  const calls = { n: 0 };
  const rename = (a, b) => {
    calls.n += 1;
    if (calls.n <= 2) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    renameSync(a, b);
  };
  const r = swapPluginCurrent(dir, "bbb", { platform: "win32", rename, sleep: () => {} });
  assert.ok(calls.n >= 4, "two failed tries, then both renames");
  assert.equal(realpathSync(current(dir)), path.join(dir, "bbb"));
  assert.equal(r.previous, path.join(dir, "aaa"));
  assert.equal(existsSync(path.join(dir, "current.old")), false);
});

test("[win] plugin-swap/EPERM-that-never-clears-throws-and-keeps-old-current", (t) => {
  const dir = agentDir(t);
  version(dir, "aaa");
  swapPluginCurrent(dir, "aaa");
  version(dir, "bbb");
  const rename = () => { throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); };
  assert.throws(() => swapPluginCurrent(dir, "bbb", { platform: "win32", rename, sleep: () => {} }), /EPERM/);
  assert.equal(realpathSync(current(dir)), path.join(dir, "aaa"));
});

// DEVIATIONS D-WIN-JUNCTION-1 (PI-WIN-1): on Windows a `dir` symlink needs admin or Developer Mode (EPERM for a normal
// user); a junction needs neither. Fake platform + injected symlink that refuses `dir` like Windows and stores the
// junction target with a trailing slash (what readlink may return there): runs on every OS.
function winSymlink(calls) {
  return (target, link, type) => {
    calls.push({ target, link: path.basename(link), type });
    if (type !== "junction") throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
    symlinkSync(target + path.sep, link, "dir");
  };
}

test("[win] plugin-swap/win32-makes-a-junction-with-an-absolute-target", (t) => {
  const dir = agentDir(t);
  const calls = [];
  const opts = { platform: "win32", symlink: winSymlink(calls) };
  version(dir, "aaa");
  const r = swapPluginCurrent(dir, "aaa", opts);
  assert.deepEqual(calls, [{ target: path.join(dir, "aaa"), link: "current.swap", type: "junction" }]);
  assert.equal(realpathSync(current(dir)), path.join(dir, "aaa"));
  assert.deepEqual(r, { current: path.join(dir, "aaa"), previous: null, removed: [] });
});

test("[win] plugin-swap/win32-junction-target-with-trailing-slash-is-read-as-the-sha", (t) => {
  const dir = agentDir(t);
  const calls = [];
  const opts = { platform: "win32", symlink: winSymlink(calls), sleep: () => {} };
  for (const sha of ["aaa", "bbb"]) { version(dir, sha); swapPluginCurrent(dir, sha, opts); }
  calls.length = 0;
  const same = swapPluginCurrent(dir, "bbb", opts);
  assert.deepEqual(same, { current: path.join(dir, "bbb"), previous: null, removed: [] }, "same sha is a no-op");
  assert.equal(calls.length, 0, "no new link for the sha that is already current");
  version(dir, "ccc");
  const r = swapPluginCurrent(dir, "ccc", opts);
  assert.equal(r.previous, path.join(dir, "bbb"));
  assert.deepEqual(r.removed, [path.join(dir, "aaa")]);
  assert.ok(existsSync(path.join(dir, "bbb")), "the rollback generation is kept");
  const back = swapPluginCurrent(dir, "bbb", opts);
  assert.equal(back.previous, path.join(dir, "ccc"));
  assert.equal(realpathSync(current(dir)), path.join(dir, "bbb"));
});

test("[win] plugin-swap/posix-keeps-the-relative-dir-link", (t) => {
  const dir = agentDir(t);
  const calls = [];
  const symlink = (target, link, type) => { calls.push({ target, type }); symlinkSync(target, link, type); };
  version(dir, "aaa");
  swapPluginCurrent(dir, "aaa", { platform: "linux", symlink });
  assert.deepEqual(calls, [{ target: "aaa", type: "dir" }]);
  assert.equal(readlinkSync(current(dir)), "aaa");
});

// Windows only: a real junction, no fake. A normal user has no symlink privilege, so only this run proves it.
test("[win] plugin-swap/real-junction-swap-and-rollback", { skip: process.platform !== "win32" && "junctions are a Windows feature" }, (t) => {
  const dir = agentDir(t);
  for (const sha of ["aaa", "bbb"]) { version(dir, sha); swapPluginCurrent(dir, sha); }
  assert.ok(lstatSync(current(dir)).isSymbolicLink());
  assert.equal(realpathSync.native(current(dir)), path.join(dir, "bbb"));
  assert.equal(swapPluginCurrent(dir, "bbb").previous, null);
  const back = swapPluginCurrent(dir, "aaa");
  assert.equal(back.previous, path.join(dir, "bbb"));
  assert.equal(realpathSync.native(current(dir)), path.join(dir, "aaa"));
  assert.equal(existsSync(path.join(dir, "current.old")), false);
});
