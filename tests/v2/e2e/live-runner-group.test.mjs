// D-CR3-WATCHDOG-1 (round 4 review item 1). Every non-frozen live runner that spawns `claude -p` must run it
// through e2e/live/lib/proc-group.mjs, so a timeout kills the whole process group, not only the direct child.
// The frozen runners (e2e/live/compact-hard/*, bench/m2/*) are not listed here and are not edited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGroup } from "../../../e2e/live/lib/proc-group.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const RUNNERS = [
  "e2e/live/run.mjs",
  "e2e/live/routing/run.mjs",
  "e2e/live/compact/session.mjs",
  "bench/live/run.mjs",
  "bench/live/ab-quick.mjs",
  "bench/saving-score.mjs",
  "e2e/live/npm-package/claude-code.mjs",
];

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("runGroup timeout kills the grandchild and reports timedOut", { skip: process.platform === "win32" ? "POSIX process groups" : false }, async () => {
  const r = await runGroup("/bin/sh", ["-c", "sleep 300 & echo $!; wait"], {}, 500);
  assert.equal(r.timedOut, true, "the run is marked timed out");
  const grand = Number(r.stdout.trim());
  assert.ok(grand > 0, "the grandchild pid was printed");
  for (let i = 0; i < 50 && alive(grand); i++) await sleep(20);
  assert.equal(alive(grand), false, "the grandchild died with the group");
});

test("runGroup returns stdout and status for a run that ends in time", async () => {
  const r = await runGroup(process.execPath, ["-e", "console.log('ok')"], {}, 5000);
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "ok");
});

test("every non-frozen claude -p runner imports the process-group helper and no longer kills only the child", () => {
  for (const f of RUNNERS) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(src.includes("proc-group.mjs"), `${f} imports proc-group.mjs`);
    assert.ok(!src.includes("child.kill(") && !src.includes("p.kill(") && !src.includes("c.kill("), `${f} kills by process group, not by child.kill`);
  }
});
