// Field-by-field goldens for the Claude Code PostToolUse decode (D-FU-RF-DECODE-1). Base payload: the real
// 2.1.303 Bash capture (e2e/fixtures/claude-code/2.1.303/PostToolUse-Bash-large.json, 8892 bytes of stdout).
// Rule: a field the hooks docs list as always present may be required; every other field has a defined
// default. Required here: hook_event_name, tool_name, tool_response. Dropping an optional field still
// replaces. Dropping a required field gives exit 0, empty stdout and one stderr (debug log) line that
// names the field, never a silent drop.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decode } from "../../../src/adapters/claude-code.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ENTRY = join(ROOT, "src", "entries", "hook.ts");
const GOLDEN = join(ROOT, "e2e", "fixtures", "claude-code", "2.1.303", "PostToolUse-Bash-large.json");
const BASE = JSON.parse(readFileSync(GOLDEN, "utf8"));
const FULL_BYTES = Buffer.byteLength(BASE.tool_response.stdout);
let root;
let repo;

before(() => {
  root = mkdtempSync(join(tmpdir(), "cm-decode-lenient-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
});

after(() => rmSync(root, { recursive: true, force: true }));

function payload() {
  const p = structuredClone(BASE);
  p.cwd = repo;
  p.transcript_path = join(root, "transcript.jsonl");
  return p;
}

// D-R4-HANDLE-LABEL-1: the label is no longer in the replace; it is the stored source row's label.
function storedLabel() {
  const projects = join(root, ".context-mode", "projects");
  const db = new DatabaseSync(join(projects, readdirSync(projects)[0], "context.db"), { readOnly: true });
  try { return db.prepare("SELECT label FROM sources ORDER BY id DESC LIMIT 1").get().label; } finally { db.close(); }
}

function run(p) {
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, CLAUDE_PROJECT_DIR: repo };
  return spawnSync(process.execPath, [ENTRY, "--agent", "claude-code"], { input: JSON.stringify(p), cwd: repo, env, encoding: "utf8" });
}

// The replace D-M7-RL-1 checks: Bash output shape, far shorter than the full output, names the source.
function assertReplaced(r, what) {
  assert.equal(r.status, 0, what + " " + r.stderr);
  assert.notEqual(r.stdout, "", what + ": empty stdout");
  const hso = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(hso.hookEventName, "PostToolUse", what);
  const out = hso.updatedToolOutput;
  assert.equal(typeof out, "object", what);
  assert.deepEqual(Object.keys(out).sort(), ["interrupted", "stderr", "stdout"], what);
  assert.ok(Buffer.byteLength(out.stdout) * 10 < FULL_BYTES, what + ": " + Buffer.byteLength(out.stdout) + " bytes");
  assert.ok(out.stdout.includes("ctx_search("), what);
  return out.stdout;
}

const OPTIONAL_TOP = ["session_id", "transcript_path", "cwd", "prompt_id", "permission_mode", "effort", "tool_input", "tool_use_id", "duration_ms"];
const OPTIONAL_RESPONSE = ["stderr", "interrupted", "isImage", "noOutputExpected"];
const REQUIRED = ["hook_event_name", "tool_name", "tool_response"];

test("the base payload carries every field this file drops", () => {
  for (const f of [...OPTIONAL_TOP, ...REQUIRED]) assert.ok(f in BASE, f);
  for (const f of ["stdout", ...OPTIONAL_RESPONSE]) assert.ok(f in BASE.tool_response, "tool_response." + f);
});

for (const field of OPTIONAL_TOP) {
  test(`D-FU-RF-DECODE-1: optional ${field} dropped -> still replaces`, () => {
    const p = payload();
    delete p[field];
    assertReplaced(run(p), "-" + field);
  });
}

for (const field of OPTIONAL_RESPONSE) {
  test(`D-FU-RF-DECODE-1: optional tool_response.${field} dropped -> still replaces`, () => {
    const p = payload();
    delete p.tool_response[field];
    assertReplaced(run(p), "-tool_response." + field);
  });
}

test("D-FU-RF-DECODE-1: optional tool_response.stdout dropped -> defaults to \"\", a large stderr still replaces", () => {
  const p = payload();
  p.tool_response.stderr = p.tool_response.stdout;
  delete p.tool_response.stdout;
  const text = assertReplaced(run(p), "-tool_response.stdout");
  assert.ok(!text.includes('\\n'), "read as plain lines, not one escaped JSON string");
});

test("D-FU-RF-DECODE-1: tool_use_id dropped -> label from a hash of the command and turn, stable per command", () => {
  const p = payload();
  delete p.tool_use_id;
  assertReplaced(run(p), "-tool_use_id a");
  const la = storedLabel();
  const label = la.match(/Bash:seq 1 2000#(\S+)$/);
  assert.ok(label !== null, la);
  assert.match(label[1], /^h[0-9a-f]{8}$/);
  assertReplaced(run(p), "-tool_use_id b");
  assert.ok(storedLabel().includes("#" + label[1]), "same command, same turn -> same label");
  const q = payload();
  delete q.tool_use_id;
  q.tool_input.command = "seq 1 2000 # other";
  assertReplaced(run(q), "-tool_use_id other command");
  assert.ok(!storedLabel().includes("#" + label[1]), "another command -> another label");
});

for (const field of REQUIRED) {
  test(`D-FU-RF-DECODE-1: required ${field} dropped -> exit 0, empty stdout, one debug line naming it`, () => {
    const p = payload();
    delete p[field];
    const r = run(p);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "");
    const lines = r.stderr.split("\n").filter((l) => l !== "");
    assert.equal(lines.length, 1, r.stderr);
    assert.ok(lines[0].startsWith("hooks: decode failed: "), lines[0]);
    assert.ok(lines[0].includes("missing required field " + field), lines[0]);
  });
}

test("D-FU-RF-DECODE-1: decode defaults: cwd -> CLAUDE_PROJECT_DIR, else process.cwd(); session_id -> \"\"; tool_input -> {}", () => {
  const p = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: { stdout: "x" } };
  const old = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = repo;
    const ev = decode(p);
    assert.equal(ev.cwd, repo);
    assert.equal(ev.sessionId, "");
    assert.deepEqual(ev.tool.input, {});
    delete process.env.CLAUDE_PROJECT_DIR;
    assert.equal(decode(p).cwd, process.cwd());
  } finally {
    if (old === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = old;
  }
});

test("D-FU-RF-DECODE-1: a given tool_use_id still wins over the hash default", () => {
  const ev = decode({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "", tool_use_id: "toolu_9" });
  assert.equal(ev.tool.callId, "toolu_9");
});
