// src/setup/spawn-bin.ts: find an agent CLI on PATH and the spawn form that runs it, shared by setup and
// scripts/release/smoke.mjs (D-RN-WIN-1). No other imports, so a release script can load it alone.
import { accessSync, constants as fsc, statSync } from "node:fs";
import path from "node:path";

type Env = Record<string, string | undefined>;
const WIN_EXT = ".COM;.EXE;.BAT;.CMD";
const WIN_SHIM_EXTS: readonly string[] = Object.freeze([".cmd", ".bat"]);
const DEFAULT_COMSPEC = "cmd.exe";

/** Env value by key, matched without case (Windows spells PATH as `Path`, ComSpec as `COMSPEC`). */
function envGet(env: Env, k: string): string | undefined {
  return env[Object.keys(env).find((x) => x.toUpperCase() === k) ?? k];
}

/** The directories of a PATH value. On Windows an entry may be wrapped in one pair of double quotes (cmd.exe accepts
 *  it, and `path.join` would keep the quotes), so one surrounding pair is cut off with slice; an entry that is empty
 *  after that is dropped. An unpaired quote stays as is. POSIX entries are used as they are. */
export function pathEntries(value: string, platform: NodeJS.Platform = process.platform): string[] {
  const win = platform === "win32";
  return value.split(win ? ";" : ":").map((e) => (win && e.length >= 2 && e.startsWith('"') && e.endsWith('"') ? e.slice(1, -1) : e)).filter(Boolean);
}

/** PATH lookup the way the host shell does it. On Windows, npm installs an agent CLI as `<bin>.cmd` (next to an
 *  extensionless sh script that cmd.exe cannot run), so only PATHEXT names match there. Env keys are matched without
 *  case, since Windows spells PATH as `Path`. */
export function whichBin(bin: string, env: Env, platform: NodeJS.Platform = process.platform): string | undefined {
  const get = (k: string): string | undefined => envGet(env, k);
  const win = platform === "win32";
  const exts = win ? (get("PATHEXT") || WIN_EXT).split(";").filter(Boolean) : [""];
  const names = win && path.extname(bin) ? [bin] : exts.map((e) => bin + e.toLowerCase());
  for (const dir of pathEntries(get("PATH") ?? "", platform)) {
    for (const n of names) {
      const f = path.join(dir, n);
      try { accessSync(f, fsc.X_OK); if (statSync(f).isFile()) return f; } catch { /* next */ }
    }
  }
  return undefined;
}

/** cmd.exe line for a .cmd/.bat shim: Node refuses to spawn those without a shell (CVE-2024-27980). Each argument is
 *  quoted, so paths with spaces survive; the outer quotes are the /s form. */
export function winCmdLine(file: string, args: string[]): string {
  const q = (a: string): string => (a === "" || /[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  return `"${[file, ...args].map(q).join(" ")}"`;
}

export interface SpawnForm { command: string; args: string[]; windowsVerbatimArguments: boolean; }

/** How to spawn `file args`. On Windows a .cmd/.bat shim runs through `%ComSpec% /d /s /c "<line>"` with verbatim
 *  arguments (the documented way since CVE-2024-27980); any other file, and every file elsewhere, runs as is. */
export function spawnForm(file: string, args: string[], env: Env, platform: NodeJS.Platform = process.platform): SpawnForm {
  if (platform === "win32" && WIN_SHIM_EXTS.includes(path.extname(file).toLowerCase())) {
    return { command: envGet(env, "COMSPEC") || DEFAULT_COMSPEC, args: ["/d", "/s", "/c", winCmdLine(file, args)], windowsVerbatimArguments: true };
  }
  return { command: file, args, windowsVerbatimArguments: false };
}
