// ADR-0023: every install page opens with the host's own native install command, then the native update command,
// then "Check: `context-mode doctor`". Hosts with no native step shipped yet open with the npm fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkNativePages, installSection, fencedBlocks } from "../../../build/check-install-docs.mjs";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...p) => readFileSync(path.join(REPO, ...p), "utf8");

const NPM = ["npm i -g context-mode@next", "context-mode setup --agents"];
// id -> [install block lines, update block lines]
const NATIVE = {
  "claude-code": [["claude plugin marketplace add mksglu/context-mode", "claude plugin install context-mode@context-mode"], ["claude plugin update context-mode@context-mode"]],
  codex: [["codex plugin marketplace add mksglu/context-mode", "codex plugin add context-mode@context-mode"], ["codex plugin marketplace upgrade context-mode"]],
  gemini: [["gemini extensions install https://github.com/mksglu/context-mode"], ["gemini extensions update context-mode"]],
  qwen: [["qwen extensions install https://github.com/mksglu/context-mode:context-mode"], ["qwen extensions update context-mode"]],
  pi: [["pi install npm:context-mode@next"], ["pi update --extensions"]],
  opencode: [["opencode plugin context-mode@next --global"], ["opencode plugin context-mode@next --global --force"]],
};
const FALLBACK = ["copilot-cli", "vscode", "kiro", "zcode"];

test("install-native: each native page opens with the host's own command, then the update command", () => {
  for (const [id, [install, update]] of Object.entries(NATIVE)) {
    const blocks = fencedBlocks(installSection(read("docs", "install", `${id}.md`)));
    assert.deepEqual(blocks[0], install, `${id}.md first block`);
    assert.deepEqual(blocks[1], update, `${id}.md second block`);
  }
});

test("install-native: a host with no native step opens with the npm fallback and updates with context-mode upgrade", () => {
  for (const id of FALLBACK) {
    const blocks = fencedBlocks(installSection(read("docs", "install", `${id}.md`)));
    assert.deepEqual(blocks[0], ["npm i -g context-mode@next", `context-mode setup --agents ${id}`], `${id}.md first block`);
    assert.deepEqual(blocks[1], ["context-mode upgrade"], `${id}.md second block`);
  }
});

test("install-native: every page says check: context-mode doctor and what next is, and has no node -e", () => {
  for (const id of [...Object.keys(NATIVE), ...FALLBACK]) {
    const text = read("docs", "install", `${id}.md`);
    const install = installSection(text);
    assert.ok(install.includes("Check: `context-mode doctor`"), `${id}.md lacks the check line`);
    assert.ok(install.includes("`next` is the v2 prerelease tag"), `${id}.md lacks the next line`);
    assert.ok(!text.includes("node -e"), `${id}.md has node -e`);
  }
});

test("install-native: the real pages pass checkNativePages", () => {
  const pages = Object.fromEntries([...Object.keys(NATIVE), ...FALLBACK].map((id) => [`${id}.md`, read("docs", "install", `${id}.md`)]));
  assert.deepEqual(checkNativePages(pages), []);
});

test("install-native: checkNativePages fails a page that opens with the npm route on a native host, or lacks check, update or next", () => {
  const bad = "# Install context-mode v2 on Codex\n\n## Install\n\n```sh\nnpm i -g context-mode@next\ncontext-mode setup --agents codex\n```\n\n## What setup changes\n";
  const out = checkNativePages({ "codex.md": bad }).join("\n");
  for (const s of ["codex.md first block is the npm route", "codex.md needs an update block", "codex.md needs Check: `context-mode doctor`", "codex.md needs the next-tag line"]) assert.ok(out.includes(s), s + "\n" + out);
  const fb = checkNativePages({ "kiro.md": bad.replace("Codex", "Kiro") }).join("\n");
  assert.ok(!fb.includes("first block is the npm route"), "a fallback host may open with npm: " + fb);
});

test("install-native: both README files list every host with its native install and update command", () => {
  for (const file of [["README.md"], ["docs", "install", "README.md"]]) {
    const text = read(...file);
    for (const [id, [install, update]] of Object.entries(NATIVE)) {
      for (const cmd of [...install, ...update]) assert.ok(text.includes(`\`${cmd}\``), `${file.join("/")} lacks ${cmd} (${id})`);
    }
    assert.ok(text.includes("`next` is the v2 prerelease tag"), `${file.join("/")} lacks the next line`);
    assert.ok(text.includes("context-mode doctor"), `${file.join("/")} lacks doctor`);
    assert.ok(!text.includes("node -e"), `${file.join("/")} has node -e`);
  }
});
