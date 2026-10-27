# Upgrade check: does npm update reach each agent?

Question: after `npm i -g context-mode@next`, with no setup run, does each agent run the new build?

Short answer: nine of ten agents run the npm files. Claude Code runs its own copy, so it needs one step.

## How it was measured

- Branch v2-design. Two builds, 2.0.0-next.900 and 2.0.0-next.901, packed as tarballs.
- Temp HOME and temp npm prefix. Install 900, run `context-mode setup --yes --agents <agent>`, then install 901 with no setup.
- Then check which version the host config points to and which version the host reports.
- `hook.mjs` and `server.mjs` have the same sha in both builds. Only `package.json` and the manifests carry the version. A sha check of the bundles cannot show a stale copy.
- The host docs were not read on the web. Evidence is the files and the host's own list command.

## Result per agent

| Agent | Reached by npm update? | Where a copy lives | What the user does |
|---|---|---|---|
| Claude Code | No (before fix D-US-1) | `~/.claude/plugins/cache/context-mode/context-mode/<version>`, recorded in `~/.claude/plugins/installed_plugins.json` | `context-mode upgrade`, or `context-mode setup --repair`, or `claude plugin update context-mode@context-mode`. Restart. |
| Codex | Yes | None. `hooks.json` and `config.toml` point into the npm global dir. | Restart. |
| Gemini CLI | Yes | None. The extension is a link (`.gemini-extension-install.json`, type `link`) to the npm dir. `gemini extensions list` showed 2.0.0-next.901 after the update. | Restart. |
| Qwen Code | Yes | None. Link extension to the npm dir. `qwen extensions list` showed 2.0.0-next.901. | Restart. |
| Copilot CLI | Yes (from code, not measured) | None. The MCP entry and the hook file point to the npm files. | Restart. |
| OpenCode | Yes (from code, not measured) | None. `opencode.json` points to the npm files. | Restart. |
| Pi | Yes (from code, not measured) | `pi install <package dir>` is run by setup. Not checked whether Pi copies. | Restart. If Pi keeps a copy, run `context-mode setup --repair`. |
| VS Code | Yes (from code, not measured) | None. `~/.vscode/mcp.json` points to the npm files. | Restart. |
| Kiro | Yes (from code, not measured) | None. `mcp.json` points to the npm files. | Restart. |
| Z Code | Yes (from code, not measured) | None. `config.json` points to the npm files. | Restart. |

## Claude Code, in detail

- Setup runs `claude plugin marketplace add` and `claude plugin install`. Claude Code copies the bundle to its plugin cache. The hook and MCP commands come from the cached `plugin.json`.
- After `npm i -g` of 901, `context-mode --version` said 901. The cache still held only the 900 dir. The registered hook ran the 900 copy.
- Fix (D-US-1): `context-mode doctor` FAILs while the recorded version differs from the installed package, and prints the fix line. `setup` and `upgrade` run `claude plugin update context-mode@context-mode`.
- Checked live with Claude Code 2.1.310: doctor FAIL, then `setup --repair` PASS, `installed_plugins.json` moved to 901, doctor PASS.

## Known limits

- Codex paths are absolute and include the npm prefix and the node path. A prefix change (nvm, node upgrade) breaks them. Run `context-mode setup --repair` then.
- Rows marked "from code, not measured" come from `src/setup/registry.ts`, not from a run of the host.
- The `next` dist-tag was not on npm during the check (only `latest` 1.0.169 was seen over 5 hours). Tests used local tarballs.
- No Claude Code docs page was fetched.

## Sources

- `src/setup/registry.ts` (`copyFor`, `cliFor`, `configFor`)
- `docs/v2/DEVIATIONS.md` row D-US-1
- `docs/install/README.md`, section Updating
- `docs/v2/review/upgrade-sync.workflow.js`
- Live runs with Claude Code 2.1.310, Gemini CLI 0.65.0, Qwen Code 0.26.1 in temp HOME dirs.
