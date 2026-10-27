// homeDirOf(env, platform): the one home rule (D-M1-T3-1, superseded on win32 by D-WIN-HOME-2).
// Windows hosts (Gemini, pi, Claude Code, Codex) take their home from os.homedir(), which is USERPROFILE and never HOME,
// so on win32 USERPROFILE wins. POSIX keeps HOME first. These cases pass the platform in, so they run on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homeDirOf, resolveConfigDir } from "../../../src/core/project/config-dir.ts";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("[WIN] home-dir: win32 prefers USERPROFILE over a different HOME (Git Bash, MSYS, CI shells) (GEM-WIN-3, PI-WIN-4)", () => {
  const env = { HOME: "/c/Users/x", USERPROFILE: "C:\\Users\\x" };
  assert.equal(homeDirOf(env, "win32"), "C:\\Users\\x");
});

test("[WIN] home-dir: win32 order is USERPROFILE, HOMEDRIVE+HOMEPATH, HOME", () => {
  assert.equal(homeDirOf({ HOME: "/h", HOMEDRIVE: "D:", HOMEPATH: "\\Users\\y" }, "win32"), "D:\\Users\\y");
  assert.equal(homeDirOf({ HOME: "/h", HOMEDRIVE: "D:" }, "win32"), "/h", "HOMEPATH missing: HOMEDRIVE alone is not a home");
  assert.equal(homeDirOf({ HOME: "/h", HOMEPATH: "\\Users\\y" }, "win32"), "/h", "HOMEDRIVE missing: HOMEPATH alone is not a home");
  assert.equal(homeDirOf({ HOME: "/h" }, "win32"), "/h", "HOME is the last resort, so a test env with only HOME works");
  assert.equal(homeDirOf({ USERPROFILE: "", HOME: "/h" }, "win32"), "/h", "empty USERPROFILE counts as unset");
  assert.equal(homeDirOf({}, "win32"), null);
});

test("home-dir: POSIX keeps HOME first, then USERPROFILE (D-M1-T3-1)", () => {
  for (const platform of ["linux", "darwin"]) {
    assert.equal(homeDirOf({ HOME: "/home/x", USERPROFILE: "/other" }, platform), "/home/x");
    assert.equal(homeDirOf({ USERPROFILE: "/other" }, platform), "/other");
    assert.equal(homeDirOf({ HOME: "", USERPROFILE: "/other" }, platform), "/other");
    assert.equal(homeDirOf({ HOMEDRIVE: "C:", HOMEPATH: "\\x" }, platform), null, "HOMEDRIVE+HOMEPATH is a Windows rule only");
  }
});

test("[WIN] home-dir: resolveConfigDir on the live platform uses the same rule (HOME and USERPROFILE differ)", () => {
  const a = mkdtempSync(join(tmpdir(), "cm-home-a-"));
  const b = mkdtempSync(join(tmpdir(), "cm-home-b-"));
  try {
    const env = { HOME: a, USERPROFILE: b };
    const want = process.platform === "win32" ? b : a;
    assert.equal(resolveConfigDir(env), realpathSync.native(join(want, ".context-mode")));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("[WIN] home-dir: requireHomeDir names USERPROFILE on win32 and HOME on POSIX when nothing is set (Q-WIN-3)", async () => {
  const { requireHomeDir } = await import("../../../src/core/project/config-dir.ts");
  assert.throws(() => requireHomeDir({}, "win32"), (e) => e.code === "NO_HOME" && /USERPROFILE/.test(e.message));
  assert.throws(() => requireHomeDir({}, "linux"), (e) => e.code === "NO_HOME" && /\bHOME\b/.test(e.message) && !/USERPROFILE/.test(e.message));
  assert.equal(requireHomeDir({ HOME: "/h" }, "linux"), "/h");
});

test("[WIN] home-dir: qwen under Git Bash HOME resolves to USERPROFILE\\.qwen (Q-WIN-3)", async () => {
  const { AGENT_HOME_DIR } = await import("../../../src/core/contracts/constants.ts");
  const { win32 } = await import("node:path");
  const home = homeDirOf({ HOME: "C:\\msys\\home\\u", USERPROFILE: "C:\\Users\\u" }, "win32");
  assert.equal(win32.join(home, ...AGENT_HOME_DIR.qwen), "C:\\Users\\u\\.qwen");
});
