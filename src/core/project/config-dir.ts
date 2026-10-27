// impl/02 §4, impl/00 §2 (store), DEVIATIONS D-M1-6, D-M1-T3-1.
// The one config-dir reader: every module gets ~/.context-mode from here, none reads HOME again.
// D-CI-PERF-3: node:fs through getBuiltinModule; a static ESM import of node:fs also loads fs/promises, readline and streams.
const { mkdirSync, realpathSync } = process.getBuiltinModule("node:fs") as typeof import("node:fs");
import { join } from "node:path";
import { AGENT_HOME_DIR, CLAUDE_CONFIG_DIR_ENV, CODEX_HOME_ENV, DATA_ROOT } from "../contracts/constants.ts";
import { CtxError } from "../contracts/errors.ts";

/** D-M1-T3-1: HOME, then USERPROFILE; an empty value counts as unset. null when neither is set (D-M3-F-8). */
export function homeDirOf(env: NodeJS.ProcessEnv): string | null {
  const home = env.HOME;
  if (home !== undefined && home !== "") return home;
  const profile = env.USERPROFILE;
  if (profile !== undefined && profile !== "") return profile;
  return null;
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

function homeOf(env: NodeJS.ProcessEnv): string {
  const home = homeDirOf(env);
  if (home !== null) return home;
  throw new CtxError("NO_HOME", { name: process.platform === "win32" ? "USERPROFILE" : "HOME" });
}

/** impl/02 §4 steps 1-4: expand DATA_ROOT ("~/.context-mode"), create it if absent, return its realpath. */
export function resolveConfigDir(env: NodeJS.ProcessEnv): string {
  const dir = join(homeOf(env), DATA_ROOT.slice(1)); // DATA_ROOT is "~" + "/.context-mode"; join drops the lead "/"
  mkdirSync(dir, { recursive: true });
  return realpathSync.native(dir); // same canonical form as resolve.ts and contain.ts (review-M1 #1)
}
