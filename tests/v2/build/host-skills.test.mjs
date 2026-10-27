// D-HQ-SKILLS-2: for every host, the skill text that host ends up with names that host's real tool name and no
// other host's. Package hosts read the built dir of their skill channel; home-dir hosts get what setup writes
// (renderSkill of the built package's skill source with the host prefixes, as planSkills does).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ADAPTERS } from "../../../src/adapters/table.ts";
import { TOOL_ORDER } from "../../../src/core/contracts/constants.ts";
import { buildRegistry, renderSkill } from "../../../src/setup/registry.ts";
import { denyMessage } from "../../../src/core/policy/decide.ts";
import { COMPACT_POINTER_LINE, prefixToolNames } from "../../../src/core/contracts/constants.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILLS = ["ctx-doctor", "ctx-stats", "ctx-upgrade"];
const SOURCE = Object.fromEntries(SKILLS.map((s) => [s, readFileSync(path.join(REPO, "skills", s, "SKILL.md"), "utf8")]));

// One build for both tests. --generated-only first, as the CI gate does: parallel test files that build too would
// otherwise delete src/prompt/_generated.ts under this build (D-M5-P2-5).
let scratch;
let out;
before(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "cm-v2-host-skills-"));
  out = path.join(scratch, "out");
  const build = (...args) => spawnSync(process.execPath, [path.join(REPO, "build", "build.mjs"), ...args], { encoding: "utf8" });
  assert.equal(build("--generated-only").status, 0);
  const r = build("--out", out);
  assert.equal(r.status, 0, r.stderr);
});
after(() => rmSync(scratch, { recursive: true, force: true }));

// The tool names the source skill text uses, and the names a host may have in its text.
const toolsIn = (text) => TOOL_ORDER.filter((tool) => text.includes(tool));

function shipped(out, id) {
  const reg = buildRegistry({ home: path.join(out, "no-home"), pkgDir: out, env: {} }).find((r) => r.id === id);
  const s = reg.skillInstall;
  if (s.kind === "package") {
    // D-HQ-SKILLS-3: hosts that read the same package dir share one text, so it names every sharing host's tool.
    const sharers = ADAPTERS.filter((a) => a.skillChannel.kind === "package" && a.skillChannel.path === s.via);
    return { prefixes: [...new Set(sharers.map((a) => a.toolNamePrefix))],
      texts: Object.fromEntries(SKILLS.map((n) => [n, readFileSync(path.join(out, s.via, n, "SKILL.md"), "utf8")])) };
  }
  return { prefixes: s.prefixes, texts: Object.fromEntries(s.files.map((f) => [f.name, renderSkill(readFileSync(f.src, "utf8"), s.prefixes)])) };
}

test("[D-HQ-SKILLS-2] every host's shipped skill text names exactly its own real tool names", () => {
  for (const row of ADAPTERS) {
    const { prefixes, texts } = shipped(out, row.id);
    assert.deepEqual(Object.keys(texts).sort(), SKILLS, row.id);
    for (const name of SKILLS) {
      let rest = texts[name];
      for (const tool of toolsIn(SOURCE[name])) {
        for (const p of prefixes) {
          assert.ok(rest.includes(p + tool), `${row.id} ${name} names ${p + tool}`);
          rest = rest.split(p + tool).join("");
        }
      }
      assert.equal(rest.includes("ctx_"), false, `${row.id} ${name} names a tool that is not this host's: ${rest}`);
    }
  }
});

test("[D-HQ-SKILLS-2] claude-code ships its own skills dir and the plugin reads only that dir", () => {
  const claude = ADAPTERS.find((a) => a.id === "claude-code");
  assert.equal(claude.skillChannel.path, "claude-code/skills");
  const plugin = JSON.parse(readFileSync(path.join(out, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.skills, "./claude-code/skills");
  // Claude Code adds a plugin.json skills dir to the default skills/ (which holds Gemini's text), so the marketplace entry
  // lists the dir too; for a source "./" entry that stops the default scan (plugins reference, checked on claude 2.1.274).
  const entry = JSON.parse(readFileSync(path.join(out, ".claude-plugin", "marketplace.json"), "utf8")).plugins[0];
  assert.equal(entry.skills, "./claude-code/skills");
});

// N5 (2.0.0-next.5 live runs): codex ctx-stats said "mcp_context-mode_mcp__context_mode__ctx_stats". Setup rendered the
// home-dir skills from the package skills/ dir, which build.mjs already rendered with Gemini's prefix, so the prefix
// doubled. Expected names: each host's real tool name as the host lists it (adapters TOOL_NAME_PREFIX, D-HQ-COPILOT-NAMES-2).
const CTX_STATS_NAME = {
  "claude-code": "mcp__plugin_context-mode_context-mode__ctx_stats",
  codex: "mcp__context_mode__ctx_stats",
  gemini: "mcp_context-mode_ctx_stats or mcp__context-mode__ctx_stats", // D-HQ-SKILLS-3: gemini and qwen share <extension>/skills
  qwen: "mcp_context-mode_ctx_stats or mcp__context-mode__ctx_stats",
  "copilot-cli": "context-mode-ctx_stats", // D-HQ-COPILOT-NAMES-3: one name, Copilot CLI 1.0.103 lists MCP tools <server>-<tool>
  vscode: "mcp_context-mode_ctx_stats",
  kiro: "mcp_context-mode_ctx_stats",
  zcode: "mcp__context-mode__ctx_stats",
  pi: "ctx_stats",
  opencode: "ctx_stats",
};

test("[D-N5-SKILL-1] the built package's ctx-stats skill names each host's real tool once, never a doubled prefix", () => {
  for (const row of ADAPTERS) {
    const { texts } = shipped(out, row.id);
    assert.ok(texts["ctx-stats"].includes("Call the " + CTX_STATS_NAME[row.id] + " tool "), `${row.id}: ${texts["ctx-stats"]}`);
  }
});

// D-HQ-SKILLS-3 (live, Qwen Code 0.26.1 and Gemini CLI 0.65.0): both hosts load skills from the fixed path
// <extension>/skills and ignore a skills key in the manifest, and their native install commands take the repo or package
// root. So the one shipped skills/ dir is what both hosts load; qwen got Gemini's text (mcp_context-mode_ctx_*), which is
// not a qwen tool. The text now names both hosts' tools, and setup no longer writes a second qwen copy to ~/.qwen/skills.
test("[D-HQ-SKILLS-3] gemini and qwen both load <extension>/skills, so that dir names the tool of each host", () => {
  const qwen = ADAPTERS.find((a) => a.id === "qwen");
  const gemini = ADAPTERS.find((a) => a.id === "gemini");
  assert.deepEqual(qwen.skillChannel, { kind: "package", path: "skills" });
  assert.deepEqual(gemini.skillChannel, { kind: "package", path: "skills" });
  for (const name of SKILLS) {
    let rest = readFileSync(path.join(out, "skills", name, "SKILL.md"), "utf8");
    for (const tool of toolsIn(SOURCE[name])) {
      for (const p of [gemini.toolNamePrefix, qwen.toolNamePrefix]) {
        assert.ok(rest.includes(p + tool), `${name} names ${p + tool}`);
        rest = rest.split(p + tool).join("");
      }
    }
    assert.equal(rest.includes("ctx_"), false, `${name} names a tool that is neither gemini's nor qwen's: ${rest}`);
  }
});

// D-HQ-COPILOT-NAMES-3 (2.0.0-next.5): the copilot-cli ctx-stats skill hedged between two tool names, because copilot-cli and
// vscode wrote one shared ~/.copilot/skills. Copilot CLI 1.0.103 (runtime.node strings "github-mcp-server-search_code",
// "playwright-browser_take_screenshot") names an MCP tool <server>-<tool>, so ours is context-mode-ctx_stats and nothing else.
// The CLI loads personal skills from ~/.copilot/skills first and ~/.agents/skills next and skips a later same-name skill
// ("Skipped duplicate skill name ...; a higher-priority entry with the same name was already loaded"), so copilot-cli owns
// ~/.copilot/skills and vscode writes ~/.agents/skills: each skill file names one host's tool.
test("[D-HQ-COPILOT-NAMES-3] every shipped copilot-cli text names context-mode-ctx_* and never the VS Code name", () => {
  const copilot = ADAPTERS.find((a) => a.id === "copilot-cli");
  const vscode = ADAPTERS.find((a) => a.id === "vscode");
  assert.equal(copilot.toolNamePrefix, "context-mode-");
  assert.deepEqual(copilot.skillChannel, { kind: "home-dir", path: ".copilot/skills" });
  assert.deepEqual(vscode.skillChannel, { kind: "home-dir", path: ".agents/skills" });
  const { prefixes, texts } = shipped(out, "copilot-cli");
  assert.deepEqual(prefixes, ["context-mode-"]);
  for (const name of SKILLS) {
    assert.equal(texts[name].includes(" or "), false, `${name} hedges between two names: ${texts[name]}`);
    assert.equal(texts[name].includes("mcp_context-mode_"), false, `${name} names the VS Code tool: ${texts[name]}`);
    const tool = name.replace("ctx-", "ctx_");
    assert.equal(texts[name].split("context-mode-" + tool).length - 1, 1, `${name} names context-mode-${tool} once`);
  }
  // The hook deny text (exec and web) and the compact pointer carry the same single name.
  for (const kind of ["curl", "webfetch"]) {
    const deny = denyMessage(kind, "x", copilot);
    assert.ok(deny.includes("context-mode-ctx_"), deny);
    assert.equal(deny.includes("mcp_context-mode_"), false, deny);
  }
  const hint = prefixToolNames(COMPACT_POINTER_LINE, copilot.toolNamePrefix);
  assert.ok(hint.includes("context-mode-ctx_") && !hint.includes("mcp_context-mode_"), hint);
});
