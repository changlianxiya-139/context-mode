// D-WIN-PIDIR-1: Pi reads settings.json from $PI_CODING_AGENT_DIR, else <home>/.pi/agent. An empty value counts as unset
// (same as codexDirOf). One helper (piAgentDirOf) feeds host-write, uninstall, doctor, upgrade and the v1 scan. Before the
// fix host-write and uninstall used `??`, so "" gave join("", "settings.json") = a relative path in the cwd. Fake Windows
// paths: path.join is the host's, so assertions compare against path.join of the same inputs and run on every OS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { piAgentDirOf } from "../../../src/core/project/config-dir.ts";
import { hostConfigPath } from "../../../src/core/ops/host-write.ts";
import { runUninstall } from "../../../src/core/ops/uninstall.ts";
import { checkHostConfig } from "../../../src/core/ops/doctor-config.ts";
import { detectV1 } from "../../../src/core/ops/detect-v1.ts";
import { getAdapter } from "../../../src/adapters/table.ts";

const WIN_HOME = "C:\\Users\\Jo Doe";
const WIN_PI = "D:\\pi agent";
const PI_GIT = "git:github.com/mksglu/context-mode@release";

function tmp(t) {
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cm-pidir-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("piAgentDirOf: PI_CODING_AGENT_DIR wins, empty is unset, else <home>/.pi/agent", () => {
  assert.equal(piAgentDirOf({ PI_CODING_AGENT_DIR: WIN_PI }, WIN_HOME), WIN_PI);
  assert.equal(piAgentDirOf({ PI_CODING_AGENT_DIR: "" }, WIN_HOME), path.join(WIN_HOME, ".pi", "agent"));
  assert.equal(piAgentDirOf({}, WIN_HOME), path.join(WIN_HOME, ".pi", "agent"));
});

test("hostConfigPath: pi with an empty PI_CODING_AGENT_DIR is the default file, never a relative path", () => {
  const want = path.join(WIN_HOME, ".pi", "agent", "settings.json");
  assert.equal(hostConfigPath("pi", WIN_HOME, { PI_CODING_AGENT_DIR: "" }), want);
  assert.equal(hostConfigPath("pi", WIN_HOME, { PI_CODING_AGENT_DIR: WIN_PI }), path.join(WIN_PI, "settings.json"));
});

test("uninstall: pi with an empty PI_CODING_AGENT_DIR edits <home>/.pi/agent/settings.json", (t) => {
  const home = tmp(t);
  const file = path.join(home, ".pi", "agent", "settings.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ packages: [PI_GIT, "npm:other"] }), "utf8");
  runUninstall({ adapter: { id: "pi", installMode: "in-process" }, project: { projectKey: "abcdef0123456789" },
    env: { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: "" }, confirmDelete: false });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).packages, ["npm:other"]);
});

test("doctor D3 and hostConfigPath name the same pi file when PI_CODING_AGENT_DIR is empty", (t) => {
  const home = tmp(t);
  const env = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: "" };
  const file = hostConfigPath("pi", home, env);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ packages: [PI_GIT] }), "utf8");
  const d3 = checkHostConfig(getAdapter("pi"), env, home);
  assert.equal(d3.status, "PASS", d3.detail);
  assert.ok(d3.detail.includes(file), d3.detail);
});

test("detectV1: pi scope.piAgentDir empty is unset", (t) => {
  const home = tmp(t);
  const dir = path.join(home, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: ["npm:context-mode"] }), "utf8");
  assert.deepEqual(detectV1("pi", home, { piAgentDir: "", tmp: tmp(t) }).map((f) => f.path), ["packages.0"]);
});
