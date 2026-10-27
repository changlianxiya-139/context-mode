// impl/02 §4, impl/00 §2 (store), DEVIATIONS D-M1-6, D-M1-T3-1.
// The one config-dir reader: every module gets ~/.context-mode from here, none reads HOME again.
// D-CI-PERF-3: node:fs through getBuiltinModule; a static ESM import of node:fs also loads fs/promises, readline and streams.
const { mkdirSync, realpathSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
import { join } from "node:path";
import { AGENT_HOME_DIR, CLAUDE_CONFIG_DIR_ENV, CODEX_HOME_ENV, DATA_ROOT } from "../contracts/constants.ts";
import { CtxError } from "../contracts/errors.ts";

/** The one home rule. An empty value counts as unset; null when nothing is set (D-M3-F-8).
 *  POSIX (D-M1-T3-1): HOME, then USERPROFILE.
 *  win32 (D-WIN-HOME-2): USERPROFILE, then HOMEDRIVE+HOMEPATH, then HOME. Every host CLI is a Node program that takes its
 *  home from os.homedir(), which is USERPROFILE on Windows and ignores HOME; Git Bash, MSYS and some CI shells set HOME
 *  to another (often POSIX style) path, so HOME first would write where the host never reads.
 *  `platform` is a parameter so the rule is tested on every OS. */
export function homeDirOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  const set = (v: string | undefined): v is string => v !== undefined && v !== "";
  if (platform === "win32") {
    if (set(env.USERPROFILE)) return env.USERPROFILE;
    if (set(env.HOMEDRIVE) && set(env.HOMEPATH)) return env.HOMEDRIVE + env.HOMEPATH;
    return set(env.HOME) ? env.HOME : null;
  }
  if (set(env.HOME)) return env.HOME;
  return set(env.USERPROFILE) ? env.USERPROFILE : null;
}

/** D-N6-CODEX-HOME-2: the dir Codex reads config.toml and hooks.json from: $CODEX_HOME when set and not empty,
 *  else <home>/.codex. Same rule as setup's agentPath (D-N5-CODEX-HOME-1). */
export function codexDirOf(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env[CODEX_HOME_ENV];
  return dir !== undefined && dir !== "" ? dir : join(home, ...AGENT_HOME_DIR.codex);
}

/** D-WF-CC-CONFIG-1: the dir Claude Code keeps settings.json, plugins/ and agents/ in: $CLAUDE_CONFIG_DIR when set and
 *  not empty, else <home>/.claude. Windows profiles redirected to OneDrive set it. */
export function claudeDirOf(env: NodeJS.ProcessEnv, home: string): string {
  const dir = env[CLAUDE_CONFIG_DIR_ENV];
  return dir !== undefined && dir !== "" ? dir : join(home, ...AGENT_HOME_DIR["claude-code"]);
}

/** The one "home or fail" helper (D-WIN-HOME-3): setup, doctor, upgrade, uninstall, plugin-root and the store all call this.
 *  The NO_HOME error names the var the platform rule reads first: USERPROFILE on win32, HOME elsewhere. */
export function requireHomeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const home = homeDirOf(env, platform);
  if (home !== null) return home;
  throw new CtxError("NO_HOME", { name: platform === "win32" ? "USERPROFILE" : "HOME" });
}

/** impl/02 §4 steps 1-4: expand DATA_ROOT ("~/.context-mode"), create it if absent, return its realpath. */
export function resolveConfigDir(env: NodeJS.ProcessEnv): string {
  const dir = join(requireHomeDir(env), DATA_ROOT.slice(1)); // DATA_ROOT is "~" + "/.context-mode"; join drops the lead "/"
  mkdirSync(dir, { recursive: true });
  return realpathSync.native(dir); // same canonical form as resolve.ts and contain.ts (review-M1 #1)
}
