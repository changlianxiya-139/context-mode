#!/usr/bin/env node
// ADR-0023 (D-NI-MAIN-1): writes the files a host's native install command reads from the git repo `main`, from an
// unpacked npm package (the released bytes). The release workflow runs it in the release commit:
//   plugins/claude-code/            the Claude Code plugin (package tree without its own marketplace file;
//                                   SHA256SUMS rewritten for that tree, so ctx_upgrade verifies it)
//   .claude-plugin/marketplace.json source "./plugins/claude-code" (/plugin marketplace add mksglu/context-mode)
//   .agents/plugins/marketplace.json npm entry at this version (codex plugin marketplace add mksglu/context-mode)
// Usage: node build/main-tree.mjs --pkg <unpacked package dir> --repo <repo root> --version <x.y.z>
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeHashes } from "./hash.mjs";

const SERVER_KEY = "context-mode";
const PLUGIN_DIR = path.join("plugins", "claude-code");
const PLUGIN_SOURCE = "./plugins/claude-code";
const CLAUDE_MARKETPLACE = path.join(".claude-plugin", "marketplace.json");
const CODEX_MARKETPLACE = path.join(".agents", "plugins", "marketplace.json");

class MainTreeError extends Error {}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!["--pkg", "--repo", "--version"].includes(key) || value === undefined) throw new MainTreeError("unknown argument " + key);
    out[key.slice(2)] = value;
  }
  for (const key of ["pkg", "repo", "version"]) if (out[key] === undefined) throw new MainTreeError("missing --" + key);
  return out;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function writeMainTree(pkg, repo, version) {
  const pkgJson = readJson(path.join(pkg, "package.json"));
  if (pkgJson.version !== version) throw new MainTreeError("package version " + pkgJson.version + " is not " + version);
  const pkgMarket = readJson(path.join(pkg, CLAUDE_MARKETPLACE));
  const plugin = path.join(repo, PLUGIN_DIR);
  rmSync(plugin, { recursive: true, force: true });
  cpSync(pkg, plugin, { recursive: true });
  rmSync(path.join(plugin, CLAUDE_MARKETPLACE)); // the marketplace lives at the repo root, not inside the plugin
  writeHashes(plugin);
  writeJson(path.join(repo, CLAUDE_MARKETPLACE), {
    ...pkgMarket,
    plugins: pkgMarket.plugins.map((p) => ({ ...p, source: PLUGIN_SOURCE })),
  });
  writeJson(path.join(repo, CODEX_MARKETPLACE), {
    name: SERVER_KEY,
    interface: { displayName: SERVER_KEY },
    plugins: [{
      name: SERVER_KEY,
      source: { source: "npm", package: SERVER_KEY, version },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  });
}

try {
  const { pkg, repo, version } = parseArgs(process.argv.slice(2));
  if (!existsSync(path.join(pkg, "package.json"))) throw new MainTreeError("no package.json in " + pkg);
  writeMainTree(path.resolve(pkg), path.resolve(repo), version);
} catch (err) {
  process.stderr.write("main-tree failed: " + (err && err.message ? err.message : String(err)) + "\n");
  process.exitCode = 1;
}
