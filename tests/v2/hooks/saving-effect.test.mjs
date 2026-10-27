// tests/v2/hooks/saving-effect.test.mjs
// Spec: docs/v2/adr/0020-hooks-and-skills-on-every-agent.md decision 4 and the "Saving" column. Per host, the
// dispatch uses the strongest effect the host allows: replace (R) on claude-code and pi; deny + redirect (D) to
// the ctx tool on PreToolUse everywhere else. One effect per host, no fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ADAPTERS, getAdapter, hasReplace } from "../../../src/adapters/table.ts";
import { decide } from "../../../src/core/policy/decide.ts";

const SAVING = {
  "claude-code": "R", codex: "D", gemini: "R", qwen: "D", "copilot-cli": "R",
  vscode: "D", kiro: "D", zcode: "D", pi: "R", opencode: "D",
};
// D-M3-F-9: a hook or detached write keeps its DB handle open by design (A21), and Windows cannot delete
// an open file, so temp cleanup there is best-effort. The assertions are unchanged.
function rmTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    if (process.platform !== "win32" || err.code !== "EPERM") throw err;
  }
}

const CURL = "curl -s https://x.io/a.json";

test("ADR-0020: every row has exactly one saving effect and it matches the ADR table", () => {
  assert.deepEqual(ADAPTERS.map((r) => r.id).sort(), Object.keys(SAVING).sort());
  for (const r of ADAPTERS) assert.equal(hasReplace(r) ? "R" : "D", SAVING[r.id], r.id);
});

for (const id of Object.keys(SAVING)) {
  test(`ADR-0020: ${id} saving decision for a large-output shell call is ${SAVING[id]}`, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "cm-saving-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const row = getAdapter(id);
    const ev = { event: "PreToolUse", agent: id, sessionId: "s1", cwd: dir,
      tool: { name: "Bash", canonicalName: "Bash", input: { command: CURL } } };
    const d = decide(ev, row, []);
    if (SAVING[id] === "R") {
      assert.notEqual(d.kind, "deny", id + ": a replace host runs the call and replaces the output after");
      return;
    }
    assert.equal(d.kind, "deny", id);
    assert.ok(d.reason.includes(row.toolNamePrefix + "ctx_execute"), id + " redirect names " + row.toolNamePrefix + "ctx_execute");
    const mod = await import(`../../../src/adapters/${id}.ts`);
    const out = mod.encode(ev, d);
    const blocks = out.exitCode === 2 || /deny|block/i.test(out.stdout);
    assert.ok(blocks, id + " encode blocks the call: " + JSON.stringify(out).slice(0, 200));
    // kiro: exit 2 returns STDERR to the agent (D-HF-KIRO-SHELL-1); every other host reads stdout.
    const seen = id === "kiro" ? out.stderr : out.stdout;
    assert.ok(seen.includes("ctx_execute"), id + " the host sees the redirect");
  });
}

// D-HA-GEMINI-NAMES-1 + D-HA-GEMINI-REPLACE-1: a real Gemini AfterTool payload (native run_shell_command, large
// llmContent) goes through the hook entry and comes back as decision deny whose reason replaces the result: a short
// selection plus the ctx_search line, far below the raw size, with the whole output indexed.
test("ADR-0020: gemini AfterTool run_shell_command with a large output is replaced (decision deny + reason)", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "cm-saving-"));
  const oldHome = process.env.HOME;
  process.env.HOME = root; process.env.USERPROFILE = root;
  t.after(() => { process.env.HOME = oldHome; rmTemp(root); });
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const lines = [];
  for (let i = 0; i < 4000; i++) lines.push("line " + i + (i === 3001 ? " FATAL disk quota code=QX-7731-ZETA" : " filler words here"));
  const big = lines.join("\n") + "\n";
  const { handleHook } = await import("../../../src/core/hooks/dispatch.ts");
  const out = await handleHook("gemini", { session_id: "g1", transcript_path: "/tmp/t.json", cwd: repo, hook_event_name: "AfterTool",
    timestamp: "2026-10-25T00:00:00.000Z", tool_name: "run_shell_command", tool_input: { command: "cat logs/app.log", description: "FATAL" },
    tool_response: { llmContent: big, returnDisplay: big } }, { HOME: root, USERPROFILE: root, PATH: process.env.PATH });
  assert.equal(out.exitCode, 0);
  const j = JSON.parse(out.stdout);
  assert.equal(j.decision, "deny");
  assert.ok(Buffer.byteLength(j.reason) < Buffer.byteLength(big) / 2, "replaced text is under half the raw output");
  assert.ok(j.reason.includes("ctx_search("), "the replace names ctx_search for the rest");
});
