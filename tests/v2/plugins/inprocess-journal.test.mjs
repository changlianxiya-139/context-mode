// tests/v2/plugins/inprocess-journal.test.mjs
// OPEN-ITEMS H6 (D-HF-INPROC-JOURNAL-1): a ctx_* call that the opencode plugin or the pi extension runs in process
// must leave the same per-call journal row the MCP server writes (impl/00 §5.2 step 5, ADR-0009 §0), so ctx_stats
// counts the saving on every host. Before the fix both in-process entries wrote no row and ctx_stats showed 0 B.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as opencodePlugin from "../../../src/entries/opencode.ts";
import piExtension from "../../../src/entries/pi.ts";

let root, repo, oldHome, oldProject;
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cm-inproc-journal-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  oldHome = process.env.HOME;
  oldProject = process.env.CLAUDE_PROJECT_DIR;
  process.env.HOME = root; process.env.USERPROFILE = root;
  delete process.env.CLAUDE_PROJECT_DIR;
});
after(() => {
  process.env.HOME = oldHome;
  if (oldProject !== undefined) process.env.CLAUDE_PROJECT_DIR = oldProject;
  // The entries keep their journal DB handle open until the process exits (D-HF-INPROC-JOURNAL-1), and Windows
  // refuses to delete an open file. Only that case is tolerated; the OS temp dir is cleaned later (D-HQ-CI-WINRM-1).
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    if (process.platform !== "win32" || (err.code !== "EPERM" && err.code !== "EBUSY")) throw err;
  }
});

function rows(agent) {
  const base = join(root, ".context-mode", "projects");
  const out = [];
  for (const d of readdirSync(base)) {
    const db = new DatabaseSync(join(base, d, "context.db"), { readOnly: true });
    try {
      out.push(...db.prepare("SELECT agent, tool, session_id, sandbox_bytes, returned_bytes FROM events WHERE agent = ? AND tool = 'ctx_execute'").all(agent));
    } finally {
      db.close();
    }
  }
  return out;
}

const CODE = { language: "javascript", code: "console.log('x'.repeat(20000))" };

test("H6: opencode in-process ctx_execute writes a journal row and ctx_stats counts it", async () => {
  const registered = new Map();
  await opencodePlugin.setup({ directory: repo, tool: (name, def) => registered.set(name, def) });
  await registered.get("ctx_execute").execute(CODE, { sessionID: "oc-1" });
  const r = rows("opencode");
  assert.equal(r.length, 1, "one journal row per in-process call");
  assert.equal(r[0].session_id, "oc-1");
  assert.ok(r[0].sandbox_bytes >= 20000, "sandbox bytes are the bytes the call produced");
  assert.ok(r[0].returned_bytes < r[0].sandbox_bytes, "returned bytes are what reached the model");
  const stats = await registered.get("ctx_stats").execute({}, { sessionID: "oc-1" });
  assert.match(stats, /opencode/);
});

test("H6: pi in-process ctx_execute writes a journal row like the MCP server", async () => {
  const handlers = new Map();
  const tools = new Map();
  piExtension({ on: (n, fn) => handlers.set(n, fn), registerTool: (t) => tools.set(t.name, t) });
  await handlers.get("before_agent_start")({ systemPrompt: "" }, { cwd: repo, sessionManager: { getSessionId: () => "pi-1" } });
  await tools.get("ctx_execute").execute("c1", CODE);
  const r = rows("pi");
  assert.equal(r.length, 1, "one journal row per in-process call");
  assert.equal(r[0].session_id, "pi-1");
  assert.ok(r[0].sandbox_bytes >= 20000);
});
