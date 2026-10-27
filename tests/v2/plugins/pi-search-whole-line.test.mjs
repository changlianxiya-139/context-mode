// Live pi failure (hooks-fast pi round 1): a 254920 B log replaced through tool_result, then ctx_search
// ["FATAL"] returned "... FATAL disk controller panic" without " code=E-7731-ZETA". The replace path stored
// the output in 48-byte chunks and cut every longer line in two, so no stored chunk held the whole line.
// Drives the real src/entries/pi.ts with a fake Pi API over a real git repo and a real store (temp HOME).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import piExtension from "../../../src/entries/pi.ts";

let root;
let repo;
let oldHome;

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cm-pi-line-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  oldHome = process.env.HOME;
  process.env.HOME = root; process.env.USERPROFILE = root;
});

after(() => {
  process.env.HOME = oldHome;
  try { rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch (err) { if (process.platform !== "win32") throw err; }
});

const FATAL = "2026-10-26T10:20:00Z FATAL disk controller panic code=E-7731-ZETA";

function appLog() {
  const lines = [];
  for (let i = 0; i < 3000; i++) {
    lines.push("2026-10-26T10:" + String(i % 60).padStart(2, "0") + ":00Z INFO worker-" + (i % 17) + " processed batch " + i + " ok latency=" + ((i * 7) % 300) + "ms queue=depth" + (i % 9));
  }
  lines[1700] = FATAL;
  return lines.join("\n");
}

test("pi: after a large bash tool_result is replaced, ctx_search returns the matching log line whole", async () => {
  const handlers = new Map();
  const tools = new Map();
  piExtension({ on: (n, f) => handlers.set(n, f), registerTool: (t) => tools.set(t.name, t) });
  const ctx = { cwd: repo, sessionManager: { getSessionId: () => "pi-line-1" } };
  await handlers.get("before_agent_start")({ systemPrompt: "" }, ctx);
  const raw = appLog();
  const call = { toolName: "bash", toolCallId: "c1", input: { command: "cat app.log" } };
  assert.equal(await handlers.get("tool_call")(call, ctx), undefined);
  const out = await handlers.get("tool_result")({ ...call, content: [{ type: "text", text: raw }], isError: false }, ctx);
  assert.ok(out && Buffer.byteLength(out.content[0].text) < Buffer.byteLength(raw) / 2, "the result is replaced");
  // Above SYNC_INDEX_MAX_BYTES the chunk write is detached: wait until the source is searchable.
  let text = "";
  for (let i = 0; i < 100; i++) {
    text = (await tools.get("ctx_search").execute("c2", { queries: ["FATAL"] })).content[0].text;
    if (text.includes("FATAL")) break;
    await sleep(50);
  }
  assert.ok(text.includes(FATAL), "the whole FATAL line comes back:\n" + text);
  assert.equal(text.split(FATAL).length - 1, 1, "one hit for one matching line:\n" + text);
});
