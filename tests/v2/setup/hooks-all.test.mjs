// tests/v2/setup/hooks-all.test.mjs
// Spec: docs/v2/adr/0020-hooks-and-skills-on-every-agent.md. Setup writes each agent's one hook channel and one
// skill channel on a fresh HOME; a second run changes nothing; --remove restores every byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { getAdapter } from "../../../src/adapters/table.ts";
import { TOOL_ORDER } from "../../../src/core/contracts/constants.ts";
import { generateManifests } from "../../../build/manifests.ts";
import { buildRegistry, printPlan, runRemove, runSetup } from "../../../src/setup/index.ts";

const NODE = process.execPath;
const REPO = path.resolve(import.meta.dirname, "../../..");
const SKILLS = ["ctx-doctor", "ctx-stats", "ctx-upgrade"];

function pkg(root) {
  const dir = path.join(root, "pkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "server.mjs"), `
import { createInterface } from "node:readline";
const tools = ${JSON.stringify([...TOOL_ORDER])};
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  const result = m.method === "initialize"
    ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "context-mode", version: "2.0.0" } }
    : { tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })) };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
`);
  writeFileSync(path.join(dir, "hook.mjs"), `let s = ""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => { const p = JSON.parse(s); if (!JSON.stringify(p).includes("context-mode-doctor-hook-runs")) return; const t = "deny: run ctx_execute; ctx_search( finds the rest"; process.stderr.write(t + "\\n"); process.stdout.write(JSON.stringify({ decision: "deny", reason: t })); });\n`);
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "context-mode", version: "2.0.0" }));
  generateManifests(dir);
  for (const s of SKILLS) cpSync(path.join(REPO, "skills", s), path.join(dir, "skills", s), { recursive: true });
  for (const s of SKILLS) cpSync(path.join(REPO, "skills", s), path.join(dir, "pi", "skills", s), { recursive: true }); // D-HQ-SKILLS-1: pi prefix is ""
  for (const s of SKILLS) cpSync(path.join(REPO, "skills", s), path.join(dir, "claude-code", "skills", s), { recursive: true }); // D-HQ-SKILLS-2
  return dir;
}

function sandbox(t) {
  const root = mkdtempSync(path.join(tmpdir(), "cm-hooks-all-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // copilot-cli adds its MCP server through its own CLI; a stub that already lists context-mode stands in for it.
  // On Windows whichBin matches PATHEXT names only (npm's <bin>.cmd shim), so the stub is a .cmd there and cmd.exe needs its env.
  if (process.platform === "win32") writeFileSync(path.join(bin, "copilot.cmd"), "@echo context-mode\r\n");
  else writeFileSync(path.join(bin, "copilot"), "#!/bin/sh\necho context-mode\n", { mode: 0o755 });
  const win = process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {};
  return { root, home, pkgDir: pkg(root),
    env: { PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter), HOME: home, CM_HOOK_OVERHEAD_BUDGET_MS: "60000", ...win } };
}

const hookCmd = (pkgDir, id) => `"${NODE}" "${path.join(pkgDir, "hook.mjs")}" --agent ${id}`;
// Agents setup writes by file (no host CLI needed): their hook file and skill dir sit under HOME.
const FILE_AGENTS = ["codex", "copilot-cli", "vscode", "kiro", "zcode", "opencode"];

function commands(doc) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "command" && typeof x === "string") out.push(x); else walk(x); }
  };
  walk(doc);
  return out;
}

test("ADR-0020: setup writes the hook channel for every file agent with the absolute hook command", async (t) => {
  const s = sandbox(t);
  const res = await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: FILE_AGENTS, runId: "r1" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
  for (const id of ["codex", "copilot-cli", "vscode", "kiro", "zcode"]) {
    const file = path.join(s.home, getAdapter(id).hookChannel.path);
    assert.ok(existsSync(file), id + " hook file " + file);
    const cmds = commands(JSON.parse(readFileSync(file, "utf8")));
    const names = Object.keys(getAdapter(id).eventMap).filter((e) => e !== "Usage");
    // kiro: PreToolUse/PostToolUse each have an @mcp and a shell entry (D-HF-KIRO-SHELL-1).
    const events = names.length + (id === "kiro" ? names.filter((e) => e === "PreToolUse" || e === "PostToolUse").length : 0);
    assert.equal(cmds.filter((c) => c === hookCmd(s.pkgDir, id)).length, events, id + " one command per event (and per kiro matcher)");
  }
  const zc = JSON.parse(readFileSync(path.join(s.home, ".zcode", "cli", "config.json"), "utf8"));
  assert.equal(zc.hooks.enabled, true, "zcode hooks.enabled");
  assert.ok(zc.mcp.servers["context-mode"], "zcode MCP entry kept next to the hooks (D-HF-ZCODE-SHAPE-1)");
  assert.equal(zc.features.mcp, true, "zcode features.mcp");
  const oc = JSON.parse(readFileSync(path.join(s.home, ".config", "opencode", "opencode.json"), "utf8"));
  assert.deepEqual(oc.plugin, [path.join(s.pkgDir, "opencode", "plugin.js")], "opencode plugin entry");
});

test("ADR-0020: setup writes the three skills per agent with that agent's tool name prefix", async (t) => {
  const s = sandbox(t);
  const res = await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: FILE_AGENTS, runId: "r1" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
  for (const id of FILE_AGENTS) {
    const row = getAdapter(id);
    for (const name of SKILLS) {
      const file = path.join(s.home, row.skillChannel.path, name, "SKILL.md");
      assert.ok(existsSync(file), id + " " + file);
      const text = readFileSync(file, "utf8");
      const tool = name.replace("ctx-", "ctx_");
      assert.ok(text.includes(row.toolNamePrefix + tool), id + " " + name + " names " + row.toolNamePrefix + tool);
      assert.ok(text.startsWith("---\nname: " + name + "\n"), id + " frontmatter kept");
    }
  }
});

test("ADR-0020: user hooks in a shared hook file are kept; second run changes nothing; --remove restores bytes", async (t) => {
  const s = sandbox(t);
  const codexHooks = path.join(s.home, ".codex", "hooks.json");
  mkdirSync(path.dirname(codexHooks), { recursive: true });
  const user = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-hook" }] }], PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "my-lint" }] }] } }, null, 2) + "\n";
  writeFileSync(codexHooks, user);
  const first = await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["codex", "kiro"], runId: "a" });
  assert.equal(first.exitCode, 0, JSON.stringify(first.agents.map((a) => [a.id, a.status, a.reason])));
  const doc = JSON.parse(readFileSync(codexHooks, "utf8"));
  assert.ok(commands(doc).includes("my-own-hook") && commands(doc).includes("my-lint"), "user hooks kept");
  assert.equal(commands(doc).filter((c) => c === hookCmd(s.pkgDir, "codex")).length, 4);
  const after = readFileSync(codexHooks, "utf8");
  const second = await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["codex", "kiro"], runId: "b" });
  assert.deepEqual(second.agents.map((a) => a.changes), [[], []], "idempotent");
  assert.equal(readFileSync(codexHooks, "utf8"), after);
  assert.equal(runRemove({ home: s.home }).exitCode, 0);
  assert.equal(readFileSync(codexHooks, "utf8"), user, "byte-exact restore");
  assert.equal(existsSync(path.join(s.home, ".kiro", "hooks", "context-mode.json")), false, "created hook file removed");
  assert.equal(existsSync(path.join(s.home, ".codex", "skills", "ctx-stats", "SKILL.md")), false, "created skill removed");
});

test("ADR-0020: --print lists the hook step and the skill step for every agent", (t) => {
  // D-N5-SKILL-1: the package layout (pi/skills holds the bare names); the repo root has no pi/skills.
  for (const row of buildRegistry({ home: "/h", pkgDir: sandbox(t).pkgDir, env: {} })) {
    const kinds = printPlan(row).steps.map((s) => s.kind);
    assert.ok(row.hookInstall, row.id + " hookInstall");
    assert.ok(row.skillInstall, row.id + " skillInstall");
    if (getAdapter(row.id).hookChannel.kind !== "package") assert.ok(kinds.includes("hook") || kinds.includes("run"), row.id + " hook step");
    if (getAdapter(row.id).skillChannel.kind === "home-dir") assert.ok(kinds.includes("skill"), row.id + " skill step");
  }
});

// ADR-0020 step 4: doctor runs three hook checks (registered, runs, seen) and one skill check per agent.
test("ADR-0020: doctor names hook-registered, hook-runs, hook-seen and skills; seen is a WARN before the first event", async (t) => {
  const s = sandbox(t);
  const { runDoctor } = await import("../../../src/setup/index.ts");
  const agents = ["codex", "kiro", "opencode"];
  const res = await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents, runId: "r1" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
  const d = await runDoctor({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents });
  assert.equal(d.exitCode, 0, JSON.stringify(d.agents.map((a) => [a.id, a.status, a.reason])));
  for (const a of d.agents) {
    const by = Object.fromEntries(a.checks.map((c) => [c.name, c]));
    for (const n of ["hook-registered", "hook-runs", "hook-seen", "skills"]) assert.ok(by[n], a.id + " " + n);
    assert.equal(by["hook-registered"].ok, true, a.id);
    assert.equal(by["hook-runs"].ok, true, a.id);
    assert.equal(by.skills.ok, true, a.id);
    assert.equal(by["hook-seen"].warn, true, a.id + " seen is WARN");
    assert.match(by["hook-seen"].detail, /not seen yet, run one tool call/);
  }
});

test("ADR-0020: doctor hook-seen passes once the journal holds a row from that agent", async (t) => {
  const s = sandbox(t);
  const { runDoctor } = await import("../../../src/setup/index.ts");
  await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["codex"], runId: "r1" });
  const { DatabaseSync } = await import("node:sqlite");
  const { DDL } = await import("../../../src/core/store/schema.ts");
  const dir = path.join(s.home, ".context-mode", "projects", "abc");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "context.db"));
  db.exec(DDL);
  db.prepare("INSERT INTO events(session_id, worktree, agent, kind, turn, created_at, accessed_at) VALUES ('s','/w','codex','cmd',1,1,1)").run();
  db.close();
  const d = await runDoctor({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["codex"] });
  const seen = d.agents[0].checks.find((c) => c.name === "hook-seen");
  assert.equal(seen.ok, true);
  assert.notEqual(seen.warn, true);
});

test("ADR-0020: doctor fails hook-registered when the hook file lost the entry, and skills when a skill has the wrong prefix", async (t) => {
  const s = sandbox(t);
  const { runDoctor } = await import("../../../src/setup/index.ts");
  await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["kiro"], runId: "r1" });
  writeFileSync(path.join(s.home, ".kiro", "hooks", "context-mode.json"), JSON.stringify({ version: "v1", hooks: [] }));
  const skill = path.join(s.home, ".kiro", "skills", "ctx-stats", "SKILL.md");
  writeFileSync(skill, readFileSync(skill, "utf8").split("mcp_context-mode_ctx_stats").join("ctx_stats"));
  const d = await runDoctor({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["kiro"] });
  assert.equal(d.exitCode, 1);
  assert.equal(d.agents[0].status, "FAIL");
});

// Codex 0.164.0 runs a hooks.json hook only when config.toml holds [hooks.state."<realpath>:<snake_event>:<group>:<handler>"]
// trusted_hash = "sha256:<hex>" (probe: codex app-server hooks/list gives trustStatus trusted / modified / untrusted).
// The hash is sha256 of the sorted-key JSON {event_name, matcher?, hooks:[{type, command, timeout, async:false}]}
// (checked against currentHash from hooks/list for five hooks, D-HA-CODEX-TRUST-1).
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const SNAKE = { PreToolUse: "pre_tool_use", PostToolUse: "post_tool_use", SessionStart: "session_start", UserPromptSubmit: "user_prompt_submit" };
function codexTrust(file) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const out = {};
  for (const [ev, groups] of Object.entries(doc.hooks)) groups.forEach((g, gi) => g.hooks.forEach((h, hi) => {
    const id = { event_name: SNAKE[ev], hooks: [{ ...h, async: false }] };
    if (g.matcher !== undefined) id.matcher = g.matcher;
    out[`${realpathSync(file)}:${SNAKE[ev]}:${gi}:${hi}`] = { cmd: h.command, hash: "sha256:" + createHash("sha256").update(JSON.stringify(sortKeys(id))).digest("hex") };
  }));
  return out;
}

test("ADR-0020: codex setup trusts each own hook in config.toml; user hooks are not trusted; remove restores", async (t) => {
  const s = sandbox(t);
  const hooks = path.join(s.home, ".codex", "hooks.json");
  mkdirSync(path.dirname(hooks), { recursive: true });
  writeFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "my-lint" }] }] } }));
  const res = await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["codex"], runId: "a" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
  const toml = readFileSync(path.join(s.home, ".codex", "config.toml"), "utf8");
  const want = codexTrust(hooks);
  let own = 0;
  for (const [key, { cmd, hash }] of Object.entries(want)) {
    const block = `[hooks.state.${JSON.stringify(key)}]\ntrusted_hash = ${JSON.stringify(hash)}\n`;
    if (cmd === hookCmd(s.pkgDir, "codex")) { own += 1; assert.ok(toml.includes(block), "trusted: " + key); }
    else assert.ok(!toml.includes(JSON.stringify(key)), "user hook not trusted: " + key);
  }
  assert.equal(own, 4);
  assert.ok(toml.includes("[mcp_servers.context-mode]"), "server entry kept");
  const second = await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["codex"], runId: "b" });
  assert.deepEqual(second.agents.map((a) => a.changes), [[]], "idempotent");
  assert.equal(runRemove({ home: s.home }).exitCode, 0);
  assert.equal(existsSync(path.join(s.home, ".codex", "config.toml")), false, "created config.toml removed");
});

test("ADR-0020: codex doctor fails hook-registered when a trusted_hash does not match the hook", async (t) => {
  const s = sandbox(t);
  const { runDoctor } = await import("../../../src/setup/index.ts");
  await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["codex"], runId: "r1" });
  const cfg = path.join(s.home, ".codex", "config.toml");
  const toml = readFileSync(cfg, "utf8");
  const first = Object.values(codexTrust(path.join(s.home, ".codex", "hooks.json")))[0].hash;
  writeFileSync(cfg, toml.split(first).join("sha256:" + "0".repeat(64)));
  const d = await runDoctor({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["codex"] });
  const reg = d.agents[0].checks.find((c) => c.name === "hook-registered");
  assert.equal(reg.ok, false);
  assert.match(reg.detail, /not trusted/);
});

// D-HQ-COPILOT-NAMES-3: Copilot CLI 1.0.103 lists personal skills from ~/.copilot/skills before ~/.agents/skills and skips a
// later same-name skill, and its tool names differ from VS Code's (context-mode-ctx_* vs mcp_context-mode_ctx_*). So
// copilot-cli owns ~/.copilot/skills and vscode owns ~/.agents/skills; each SKILL.md names one host's tool, and setup of one
// agent never rewrites the other's skill. Supersedes the shared-dir form of D-HQ-COPILOT-NAMES-2.
test("D-HQ-COPILOT-NAMES-3: copilot-cli and vscode each own a skills dir; each SKILL.md names only its host's tool; doctor passes skills for both", async (t) => {
  const s = sandbox(t);
  const { runDoctor } = await import("../../../src/setup/index.ts");
  const dirs = { "copilot-cli": ".copilot", vscode: ".agents" };
  for (const agents of [["copilot-cli"], ["vscode"], ["copilot-cli", "vscode"]]) {
    await runSetup({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents, runId: "r-" + agents.join("-") });
    for (const id of agents) for (const name of SKILLS) {
      const text = readFileSync(path.join(s.home, dirs[id], "skills", name, "SKILL.md"), "utf8");
      const tool = name.replace("ctx-", "ctx_");
      const other = getAdapter(id === "vscode" ? "copilot-cli" : "vscode").toolNamePrefix;
      assert.ok(text.includes("Call the " + getAdapter(id).toolNamePrefix + tool + " tool "), id + " " + name + " names its own tool: " + text);
      assert.equal(text.includes(" or "), false, id + " " + name + " hedges: " + text);
      assert.equal(text.includes(other + tool), false, id + " " + name + " names the other host's tool");
    }
  }
  const d = await runDoctor({ home: s.home, pkgDir: s.pkgDir, env: s.env, agents: ["copilot-cli", "vscode"] });
  for (const a of d.agents) assert.equal(a.checks.find((c) => c.name === "skills")?.ok, true, a.id + " skills " + JSON.stringify(a.checks.find((c) => c.name === "skills")));
});

// N5 (2.0.0-next.5 live run): with CODEX_HOME set apart from HOME/.codex, setup wrote HOME/.codex/config.toml while
// `codex mcp list` reads CODEX_HOME/config.toml, so setup failed and rolled back. Codex reads its config, hooks.json
// and skills from CODEX_HOME (default ~/.codex), so setup writes all three there.
test("[D-N5-CODEX-HOME-1] setup writes codex config.toml, hooks.json and skills under CODEX_HOME when it is set", async (t) => {
  const s = sandbox(t);
  const codexHome = path.join(s.root, "codex-home");
  const env = { ...s.env, CODEX_HOME: codexHome };
  const res = await runSetup({ home: s.home, pkgDir: s.pkgDir, env, agents: ["codex"], runId: "ch" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
  assert.ok(readFileSync(path.join(codexHome, "config.toml"), "utf8").includes("[mcp_servers.context-mode]"), "MCP entry in CODEX_HOME/config.toml");
  const cmds = commands(JSON.parse(readFileSync(path.join(codexHome, "hooks.json"), "utf8")));
  assert.ok(cmds.includes(hookCmd(s.pkgDir, "codex")), "hook command in CODEX_HOME/hooks.json");
  for (const name of SKILLS) assert.ok(existsSync(path.join(codexHome, "skills", name, "SKILL.md")), name + " under CODEX_HOME/skills");
  assert.equal(existsSync(path.join(s.home, ".codex")), false, "nothing written to HOME/.codex");
});

// N6 (2.0.0-next.5 live run): Codex 0.156.1 deferred our MCP tools behind tool_search, so the model dumped the
// tool catalogue (10,730 B) before it called ctx_execute. Codex's per-server key omit_tools_from = ["deferred"]
// takes the deferred surface away, so the tools are direct (codex-rs core/src/tools/spec_plan.rs
// apply_mcp_tool_exposure_policy; config/src/mcp_types.rs omit_tools_from; `codex mcp list` rejects other values).
test("[D-N6-CODEX-DIRECT-1] setup writes omit_tools_from = [\"deferred\"] in the codex MCP entry", async (t) => {
  const { parseHostConfig, hostConfigValueAt } = await import("../../../src/core/ops/host-config.ts");
  const s = sandbox(t);
  const codexHome = path.join(s.root, "codex-home");
  const env = { ...s.env, CODEX_HOME: codexHome };
  const res = await runSetup({ home: s.home, pkgDir: s.pkgDir, env, agents: ["codex"], runId: "cd" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
  const file = path.join(codexHome, "config.toml");
  const toml = parseHostConfig("codex", file, readFileSync(file, "utf8"), "toml");
  assert.deepEqual(hostConfigValueAt(toml, ["mcp_servers", "context-mode", "omit_tools_from"]), ["deferred"]);
});

// N7 (2.0.0-next.6 codex exec run): approval policy "never" refused the ctx_execute call ("MCP tool call requires
// approval, but approval policy is never"), so the model fell back to rg. Codex's per-server key
// default_tools_approval_mode = "approve" (codex-rs config/src/mcp_types.rs RawMcpServerConfig; AppToolApproval
// auto|prompt|approve) lets our own read-only ctx tools run without approval; the plugin mcp.json sets the same key.
test("[D-N7-CODEX-APPROVE-1] setup writes default_tools_approval_mode = \"approve\" in the codex MCP entry", async (t) => {
  const { parseHostConfig, hostConfigValueAt } = await import("../../../src/core/ops/host-config.ts");
  const s = sandbox(t);
  const codexHome = path.join(s.root, "codex-home");
  const env = { ...s.env, CODEX_HOME: codexHome };
  const res = await runSetup({ home: s.home, pkgDir: s.pkgDir, env, agents: ["codex"], runId: "ca" });
  assert.equal(res.exitCode, 0, JSON.stringify(res.agents.map((a) => [a.id, a.status, a.reason])));
  const file = path.join(codexHome, "config.toml");
  const toml = parseHostConfig("codex", file, readFileSync(file, "utf8"), "toml");
  assert.equal(hostConfigValueAt(toml, ["mcp_servers", "context-mode", "default_tools_approval_mode"]), "approve");
  assert.deepEqual(hostConfigValueAt(toml, ["mcp_servers", "context-mode", "omit_tools_from"]), ["deferred"]);
});
