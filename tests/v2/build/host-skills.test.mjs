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
    return { prefixes: [ADAPTERS.find((a) => a.id === id).toolNamePrefix],
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
  gemini: "mcp_context-mode_ctx_stats",
  qwen: "mcp__context-mode__ctx_stats",
  "copilot-cli": "context-mode-ctx_stats or mcp_context-mode_ctx_stats",
  vscode: "context-mode-ctx_stats or mcp_context-mode_ctx_stats",
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
