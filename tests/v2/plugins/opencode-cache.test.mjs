// tests/v2/plugins/opencode-cache.test.mjs
// Cross-session cache guard for OpenCode (D-CACHE-PI-1 review). The pending-compact marker is keyed by the
// compacted session's id (dispatch.ts PENDING_COMPACT_META_PREFIX + sessionId), so a compaction in session A
// never changes the system payload of a new session B in the same project: B gets the same bytes as a
// session that follows no compaction, and the system prefix stays readable from cache across sessions.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as opencodePlugin from "../../../src/entries/opencode.ts";

let root;
let repo;
let oldHome;
let oldProject;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cm-oc-cache-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  oldHome = process.env.HOME;
  oldProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.HOME = root; process.env.USERPROFILE = root;
  delete process.env.CLAUDE_PROJECT_DIR;
});

// Windows keeps the plugin's store files open until the process ends; same cleanup as opencode-ported.test.mjs.
function rmTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
}

after(() => {
  process.env.HOME = oldHome;
  if (oldProject !== undefined) process.env.CLAUDE_PROJECT_DIR = oldProject;
  rmTemp(root);
});

async function systemOf(hooks, sessionID) {
  const out = { system: ["HOST SYSTEM"] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, out);
  return out.system;
}

test("opencode cache: a compaction in session A leaves the next session's system payload byte-identical", async () => {
  const plain = await opencodePlugin.setup({ directory: repo, tool: () => {} });
  const ref = await systemOf(plain, "oc-ref");

  const a = await opencodePlugin.setup({ directory: repo, tool: () => {} });
  await a["chat.message"]({ sessionID: "oc-a" }, { parts: [{ type: "text", text: "work" }] });
  await a["tool.execute.after"]({ sessionID: "oc-a", tool: "bash", callID: "c1", args: { command: "ls" } }, { output: "a b" });
  await systemOf(a, "oc-a");
  await a["experimental.session.compacting"]({ sessionID: "oc-a" });

  // A new process (new plugin load), as when the user starts a new session within minutes.
  const b = await opencodePlugin.setup({ directory: repo, tool: () => {} });
  assert.deepEqual(await systemOf(b, "oc-b"), ref, "session B system[] differs from a session with no compaction before it");
  await b["chat.message"]({ sessionID: "oc-b" }, { parts: [{ type: "text", text: "next" }] });
  assert.deepEqual(await systemOf(b, "oc-b"), ref, "session B turn 2 system[] differs");
});
