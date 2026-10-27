// tests/v2/plugins/pi-cache.test.mjs
// Cache break guard for Pi (DEVIATIONS D-CACHE-PI-1). Pi 0.73.1 rebuilds the system prompt on every
// prompt: dist/core/agent-session.js:791-797 keeps result.systemPrompt from before_agent_start, else it
// resets agent.state.systemPrompt to _baseSystemPrompt. The fake host below does the same, so a turn that
// returns {} drops our text from the system prompt and the provider writes the whole prefix again.
// Rule: between two compactions the system prompt the model sees is byte-identical on every turn.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piExtension from "../../../src/entries/pi.ts";
import { INSTRUCTIONS } from "../../../src/entries/server.ts";

let root;
let repo;
let oldHome;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cm-pi-cache-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  oldHome = process.env.HOME;
  process.env.HOME = root; process.env.USERPROFILE = root;
});

after(() => {
  process.env.HOME = oldHome;
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) { // D-M3-F-9: a kept DB handle blocks the delete on Windows; cleanup is best-effort there
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
});

function fakeHost(sid) {
  const handlers = new Map();
  const pi = { on: (name, fn) => handlers.set(name, fn), registerTool: () => {} };
  piExtension(pi);
  const ctx = { cwd: repo, sessionManager: { getSessionId: () => sid } };
  const base = "BASE SYSTEM PROMPT";
  return {
    // agent-session.js:777-797: emitBeforeAgentStart gets _baseSystemPrompt; no systemPrompt means base.
    async turn() {
      const r = await handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "p", systemPrompt: base }, ctx);
      return r?.systemPrompt ? r.systemPrompt : base;
    },
    async compact() {
      await handlers.get("session_compact")({ type: "session_compact" }, ctx);
    },
    async input(text) {
      await handlers.get("input")({ text }, ctx);
    },
    base,
  };
}

test("pi cache: the system prompt is byte-identical on turns 1..4 and keeps INSTRUCTIONS (no turn-2 break)", async () => {
  const host = fakeHost("cache-s1");
  const seen = [];
  for (let i = 0; i < 4; i++) {
    await host.input("prompt " + i);
    seen.push(await host.turn());
  }
  assert.ok(seen[0].startsWith(host.base + "\n\n"), "the host prompt stays first");
  assert.ok(seen[0].includes(INSTRUCTIONS));
  for (let i = 1; i < seen.length; i++) assert.equal(seen[i], seen[0], "turn " + (i + 1) + " system prompt differs from turn 1");
});

test("pi cache: after a compaction the new system prompt stays byte-identical on every later turn", async () => {
  const host = fakeHost("cache-s2");
  await host.input("first prompt");
  const t1 = await host.turn();
  await host.input("second prompt");
  assert.equal(await host.turn(), t1);
  await host.compact();
  await host.input("third prompt");
  const afterCompact = await host.turn(); // the compact turn: history is new anyway, so it may differ from t1
  assert.ok(afterCompact.includes(INSTRUCTIONS), "INSTRUCTIONS stay in the system prompt after a compaction");
  for (let i = 0; i < 3; i++) {
    await host.input("later prompt " + i);
    assert.equal(await host.turn(), afterCompact, "post-compact turn " + (i + 1) + " system prompt differs");
  }
});
