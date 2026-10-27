// build/build.mjs --generated-only must not rewrite an up-to-date src/prompt/_generated.ts (DEVIATIONS D-RN-GEN-1).
// release.yml run 40487200279: parallel test files run build.mjs while server children import the file;
// writeFileSync truncates first, so a child read an empty file ("does not provide an export named
// 'TOOL_DESCRIPTIONS'"). Same bytes: no write at all (same inode, same mtime).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GENERATED = path.join(REPO, "src", "prompt", "_generated.ts");
const gen = () => spawnSync(process.execPath, [path.join(REPO, "build", "build.mjs"), "--generated-only"], { encoding: "utf8" });

test("[RN] build/generated-stable: --generated-only leaves an up-to-date _generated.ts untouched (same inode, mtime, bytes)", async () => {
  const first = gen();
  assert.equal(first.status, 0, first.stderr);
  const before = statSync(GENERATED, { bigint: true });
  const bytes = readFileSync(GENERATED);
  await new Promise((r) => setTimeout(r, 50)); // a rewrite now gets a later mtime
  const second = gen();
  assert.equal(second.status, 0, second.stderr);
  const after = statSync(GENERATED, { bigint: true });
  assert.deepEqual(readFileSync(GENERATED), bytes);
  assert.equal(after.ino, before.ino, "file was replaced");
  assert.equal(after.mtimeNs, before.mtimeNs, "file was rewritten");
});
