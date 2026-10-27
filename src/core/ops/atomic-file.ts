// DEVIATIONS D-WIN-ATOMIC-1. The one place that replaces a file by rename. On Windows a rename over a file that
// another process holds open (the host watching settings.json, antivirus, an indexer) fails with EPERM/EBUSY/EACCES;
// the hold is short, so retry a few times, then fail with the file name and what to close.
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ATOMIC_RENAME_BUSY_CODES, ATOMIC_RENAME_DELAY_MS, ATOMIC_RENAME_RETRIES, ATOMIC_TMP_MARK, ATOMIC_TMP_PREFIX } from "../contracts/constants.ts";

export interface AtomicOptions {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errCode(e: unknown): string | undefined { return (e as NodeJS.ErrnoException).code; }

/** renameSync that retries "file in use" codes on win32 only; any other code or platform throws at once. */
export function renameWithRetry(from: string, to: string, opts: AtomicOptions = {}): void {
  const rename = opts.rename ?? renameSync;
  const sleep = opts.sleep ?? sleepSync;
  const win = (opts.platform ?? process.platform) === "win32";
  for (let attempt = 0; ; attempt += 1) {
    try { rename(from, to); return; } catch (e) {
      const busy = win && ATOMIC_RENAME_BUSY_CODES.includes(errCode(e) ?? "");
      if (!busy || attempt >= ATOMIC_RENAME_RETRIES) throw e;
      sleep(ATOMIC_RENAME_DELAY_MS);
    }
  }
}

/** The error for a failed replace of `file`: names the file and, for a "file in use" code, what to close. */
export function replaceFailure(file: string, e: unknown): Error {
  const busy = ATOMIC_RENAME_BUSY_CODES.includes(errCode(e) ?? "");
  const cause = (e as Error).message;
  return new Error(busy
    ? `Could not replace ${file}: ${cause}. Fix: close the program using ${file}, then re-run`
    : `Could not write ${file}: ${cause}. Fix: check the path and its permissions, then re-run`, { cause: e });
}

/** Write `text` to a tmp file next to `file`, then rename it over `file`. On failure the tmp file is removed,
 *  the old `file` is untouched, and the error names `file`. */
export function atomicWriteFile(file: string, text: string, opts: AtomicOptions = {}): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `${ATOMIC_TMP_PREFIX}${path.basename(file)}${ATOMIC_TMP_MARK}${process.pid}`);
  try {
    writeFileSync(tmp, text);
    renameWithRetry(tmp, file, opts);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw replaceFailure(file, e);
  }
}
