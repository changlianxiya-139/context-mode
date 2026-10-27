// ADR-0023 (native install per agent), step 2. Builds the release tree, packs it with npm, unpacks the tarball,
// and checks that every manifest a host's native install command reads is in the packed package and names only
// files the package ships. Then writes the main-branch tree the release workflow commits (Claude Code plugin
// subfolder + both marketplace files) from the unpacked package and checks it the same way.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const VERSION = "2.0.0";
const COMMAND_SKILLS = ["ctx-doctor", "ctx-stats", "ctx-upgrade"];
let scratch;
let pkg; // the unpacked npm tarball (package/)
let main; // the main-branch tree written from it

before(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "cm-v2-native-"));
  const out = path.join(scratch, "out");
  const b = spawnSync(process.execPath, [path.join(REPO, "build", "build.mjs"), "--out", out, "--version", VERSION], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  const dest = path.join(scratch, "pack");
  mkdirSync(dest);
  const p = spawnSync(NPM, ["pack", "--json", "--pack-destination", dest], { cwd: out, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(p.status, 0, p.stderr);
  const [info] = JSON.parse(p.stdout);
  const ex = path.join(scratch, "x");
  mkdirSync(ex);
  const t = spawnSync("tar", ["-xzf", path.join(dest, info.filename), "-C", ex], { encoding: "utf8" });
  assert.equal(t.status, 0, t.stderr);
  pkg = path.join(ex, "package");
  main = path.join(scratch, "main");
  mkdirSync(main);
  const m = spawnSync(process.execPath, [path.join(REPO, "build", "main-tree.mjs"), "--pkg", pkg, "--repo", main, "--version", VERSION], { encoding: "utf8" });
  assert.equal(m.status, 0, m.stderr);
});
after(() => rmSync(scratch, { recursive: true, force: true }));

const json = (root, rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));
const isFile = (root, rel) => existsSync(path.join(root, rel)) && statSync(path.join(root, rel)).isFile();
const ROOT_VARS = ["${CLAUDE_PLUGIN_ROOT}/", "${PLUGIN_ROOT}/", "${extensionPath}${/}", "./"];
const stripRoot = (raw) => {
  const p = raw.split('"').join("");
  const root = ROOT_VARS.find((r) => p.startsWith(r));
  return root === undefined ? p : p.slice(root.length);
};
// Every ".mjs"/".js" token of a hook command line ("node <file> --agent <id>") or a server args list.
const fileTokens = (tokens) => tokens.map(stripRoot).filter((t) => t.endsWith(".mjs") || t.endsWith(".js"));
function hookCommands(value, out = []) {
  if (Array.isArray(value)) for (const v of value) hookCommands(v, out);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "command" && typeof v === "string") out.push(v);
      else hookCommands(v, out);
    }
  }
  return out;
}
function assertServers(root, servers, label) {
  const entry = servers["context-mode"];
  assert.ok(entry, label + ": mcpServers.context-mode");
  assert.equal(entry.command, "node", label);
  const files = fileTokens(entry.args);
  assert.equal(files.length, 1, label + ": one server file in " + JSON.stringify(entry.args));
  assert.ok(isFile(root, files[0]), label + ": server file " + files[0] + " shipped");
}
function assertHooks(root, rel, label) {
  assert.ok(isFile(root, rel), label + ": hook file " + rel + " shipped");
  const cmds = hookCommands(json(root, rel));
  assert.ok(cmds.length > 0, label + ": hook commands in " + rel);
  for (const c of cmds) {
    const files = fileTokens(c.split(" "));
    assert.equal(files.length, 1, label + ": one file in " + c);
    assert.ok(isFile(root, files[0]), label + ": hook bundle " + files[0] + " shipped");
  }
}
function assertSkills(root, dir, prefix, label) {
  for (const name of COMMAND_SKILLS) {
    const rel = path.join(stripRoot(dir), name, "SKILL.md");
    assert.ok(isFile(root, rel), label + ": skill " + rel + " shipped");
    if (prefix !== "") assert.ok(readFileSync(path.join(root, rel), "utf8").includes(prefix + "ctx_"), label + ": " + rel + " names " + prefix + "ctx_*");
  }
}

test("[ADR-0023] native/claude-code: packed .claude-plugin/plugin.json names shipped server, hooks and skills", () => {
  const m = json(pkg, ".claude-plugin/plugin.json");
  assert.equal(m.name, "context-mode");
  assert.equal(m.version, VERSION);
  assertServers(pkg, m.mcpServers, "claude-code");
  assertHooks(pkg, stripRoot(m.hooks), "claude-code");
  assertSkills(pkg, m.skills, "mcp__plugin_context-mode_context-mode__", "claude-code");
});

test("[ADR-0023] native/codex: packed .codex-plugin/plugin.json names shipped mcp.json, hooks.json and codex-named skills", () => {
  const m = json(pkg, ".codex-plugin/plugin.json");
  assert.equal(m.name, "context-mode");
  assert.equal(m.version, VERSION);
  assert.ok(isFile(pkg, stripRoot(m.mcpServers)), "codex: mcpServers file " + m.mcpServers);
  const mcp = json(pkg, stripRoot(m.mcpServers));
  assertServers(pkg, mcp.mcpServers, "codex");
  assert.ok(mcp.mcpServers["context-mode"].args.includes("codex"), "codex: server runs with --agent codex");
  assertHooks(pkg, stripRoot(m.hooks), "codex");
  for (const c of hookCommands(json(pkg, stripRoot(m.hooks)))) assert.ok(c.includes("${PLUGIN_ROOT}/"), "codex: hook path is plugin-root based: " + c);
  assertSkills(pkg, m.skills, "mcp__context_mode__", "codex");
});

test("[ADR-0023] native/gemini+qwen: packed extension manifests name shipped server and hooks; no context file", () => {
  const g = json(pkg, "gemini-extension.json");
  assert.equal(g.version, VERSION);
  assert.ok(!("contextFileName" in g), "gemini: no contextFileName (ADR-0023 D5)");
  assertServers(pkg, g.mcpServers, "gemini");
  assertHooks(pkg, "hooks/hooks.json", "gemini"); // Gemini loads <extension>/hooks/hooks.json
  assertSkills(pkg, "skills", "mcp_context-mode_", "gemini"); // Gemini loads <extension>/skills
  const q = json(pkg, "qwen-extension.json");
  assert.equal(q.version, VERSION);
  assertServers(pkg, q.mcpServers, "qwen");
  assertHooks(pkg, stripRoot(q.hooks), "qwen");
  for (const name of ["GEMINI.md", "QWEN.md", "CLAUDE.md", "AGENTS.md"]) assert.ok(!existsSync(path.join(pkg, name)), "no instruction file " + name);
});

test("[ADR-0023] native/pi+opencode: packed package.json pi entries and the main entry (OpenCode plugin by package name) are shipped", () => {
  const p = json(pkg, "package.json");
  assert.equal(p.version, VERSION);
  for (const rel of p.pi.extensions) assert.ok(isFile(pkg, stripRoot(rel)), "pi extension " + rel);
  for (const dir of p.pi.skills) assertSkills(pkg, dir, "", "pi");
  assert.equal(typeof p.main, "string", "opencode: package.json main (OpenCode imports the plugin by package name)");
  assert.equal(stripRoot(p.main), "opencode/plugin.js");
  assert.ok(isFile(pkg, stripRoot(p.main)), "opencode: main " + p.main + " shipped");
});

test("[ADR-0023] native/claude-code-main: main tree marketplace points at plugins/claude-code, which holds the full plugin", () => {
  const mk = json(main, ".claude-plugin/marketplace.json");
  assert.equal(mk.name, "context-mode");
  assert.equal(typeof mk.owner.name, "string");
  assert.equal(mk.plugins.length, 1);
  const [entry] = mk.plugins;
  assert.equal(entry.name, "context-mode", "entry name equals plugin.json name (/plugin install context-mode@context-mode)");
  assert.equal(entry.source, "./plugins/claude-code");
  assert.equal(entry.version, VERSION);
  const root = path.join(main, "plugins", "claude-code");
  const m = json(root, ".claude-plugin/plugin.json");
  assert.equal(m.name, "context-mode");
  assert.equal(m.version, VERSION);
  assertServers(root, m.mcpServers, "claude-code-main");
  assertHooks(root, stripRoot(m.hooks), "claude-code-main");
  assertSkills(root, m.skills, "mcp__plugin_context-mode_context-mode__", "claude-code-main");
  for (const rel of ["run.mjs", "search.mjs", "SHA256SUMS"]) assert.ok(isFile(root, rel), "claude-code-main: " + rel);
  assert.ok(!existsSync(path.join(root, ".claude-plugin", "marketplace.json")), "no nested marketplace inside the plugin folder");
});

test("[ADR-0023] native/codex-main: main tree .agents/plugins/marketplace.json installs the npm package at this version", () => {
  const mk = json(main, ".agents/plugins/marketplace.json");
  assert.equal(mk.name, "context-mode");
  assert.equal(mk.plugins.length, 1);
  const [entry] = mk.plugins;
  assert.equal(entry.name, "context-mode", "codex plugin add context-mode@context-mode");
  assert.deepEqual(entry.source, { source: "npm", package: "context-mode", version: VERSION });
});
