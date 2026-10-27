// Z-WIN-4 (D-WIN-HOOKMERGE-1): setup finds its own hook entries by a stable marker (hook.mjs ... --agent <id>), not by the
// full command. When the node path or the package dir changes between runs (node upgrade, C:\ vs c:\, nvm-windows switch,
// 8.3 short name), the old own entry is replaced, not left next to the new one. Runs on every OS: both package dirs are
// real temp dirs, only the path text differs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { TOOL_ORDER } from "../../../src/core/contracts/constants.ts";
import { generateManifests } from "../../../build/manifests.ts";
import { isOwnHookCommand, runSetup } from "../../../src/setup/index.ts";

const REPO = path.resolve(import.meta.dirname, "../../..");

function pkg(root, name) {
  const pkgDir = path.join(root, name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(path.join(pkgDir, "server.mjs"), `
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
  writeFileSync(path.join(pkgDir, "hook.mjs"), `let s = ""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => { const t = "deny: run ctx_execute; ctx_search( finds the rest"; process.stderr.write(t + "\\n"); process.stdout.write(JSON.stringify({ decision: "deny", reason: t })); });\n`);
  writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "context-mode", version: "2.0.0" }));
  generateManifests(pkgDir);
  for (const sub of ["skills", "pi/skills", "claude-code/skills"]) {
    for (const k of ["ctx-doctor", "ctx-stats", "ctx-upgrade"]) cpSync(path.join(REPO, "skills", k), path.join(pkgDir, sub, k), { recursive: true });
  }
  return pkgDir;
}

// Every string value in a JSON value, in order.
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

const FILES = { zcode: [".zcode", "cli", "config.json"], kiro: [".kiro", "hooks", "context-mode.json"], vscode: [".copilot", "hooks", "context-mode-vscode.json"] };

for (const agent of Object.keys(FILES)) {
  test(`Z-WIN-4: ${agent}: a second setup from another package dir replaces the old own hook entries`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "cm-hook-path-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    const env = { PATH: "/usr/bin:/bin", HOME: home, USERPROFILE: home, CM_HOOK_OVERHEAD_BUDGET_MS: "60000" };
    const oldDir = pkg(root, "old pkg");
    const newDir = pkg(root, "new pkg");
    const file = path.join(home, ...FILES[agent]);
    const first = await runSetup({ home, pkgDir: oldDir, env, agents: [agent], runId: "a" });
    assert.equal(first.exitCode, 0, JSON.stringify(first.agents.map((a) => [a.id, a.status, a.reason])));
    const second = await runSetup({ home, pkgDir: newDir, env, agents: [agent], runId: "b" });
    assert.equal(second.exitCode, 0, JSON.stringify(second.agents.map((a) => [a.id, a.status, a.reason])));
    const text = readFileSync(file, "utf8");
    const own = strings(JSON.parse(text)).filter((s) => isOwnHookCommand(s, agent));
    assert.ok(own.length > 0, "own commands exist");
    for (const s of own) assert.ok(s.includes(path.join(newDir, "hook.mjs")), "only the new package dir is left: " + s);
    assert.equal(text.includes(path.join(oldDir, "hook.mjs")), false, "old package dir is gone");
  });
}

test("Z-WIN-4: isOwnHookCommand matches hook.mjs + --agent <id> by string split and nothing else", () => {
  const win = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\node_modules\\context-mode\\hook.mjs" --agent zcode';
  const low = win.split("C:\\").join("c:\\");
  assert.equal(isOwnHookCommand(win, "zcode"), true);
  assert.equal(isOwnHookCommand(low, "zcode"), true, "drive letter case");
  assert.equal(isOwnHookCommand("& " + win, "zcode"), true, "powershell field");
  assert.equal(isOwnHookCommand('"/n/node" "/p/hook.mjs" --agent zcode', "zcode"), true);
  assert.equal(isOwnHookCommand(win, "kiro"), false, "other agent");
  assert.equal(isOwnHookCommand('"/n/node" "/p/hook.mjs" --agent zcode-extra', "zcode"), false, "id is a whole word");
  assert.equal(isOwnHookCommand("my-own-hook", "zcode"), false);
  assert.equal(isOwnHookCommand('node "/p/other.mjs" --agent zcode', "zcode"), false);
  assert.equal(isOwnHookCommand("context-mode hook zcode PreToolUse", "zcode"), false, "v1 command is not this marker");
  assert.equal(isOwnHookCommand(5, "zcode"), false);
});
