# Status of the next channel

Checked 2026-10-28 against the raw registry JSON (https://registry.npmjs.org/context-mode).

## npm version on next

`next` is 2.0.0-next.8 (provenance present, SLSA v1). `latest` is still 1.0.169.

## What 2.0.0-next.8 ships

- Windows fixes on all 10 hosts. The `windows hosts` matrix (CI run 40609930810, head 4fb62aa6) ran 10 agents x 5 steps per OS: windows-latest 51 pass 0 fail, ubuntu-latest 51 pass 0 fail, macos-latest 51 pass 0 fail. Details per host: docs/v2/release/WINDOWS.md.
- D-VT-WINBASH-1: Git Bash resolver for shell languages and ctx_batch on Windows.
- D-TOML-PARSER-1: Codex config.toml is read and edited with a real TOML parser.
- D-N7-VSCODE-TOOLS-1: VS Code shell, read and web tool names.
- D-TRUST-KEYDIR-2 (found by the macOS matrix before release): `codex app-server` sometimes returned an empty reply, so setup keyed the Codex hook trust with /private/var/... while Codex uses /var/.... Setup now asks Codex up to 3 times and keys a default ~/.codex as spelled; `setup --print` uses the same key. Reproduced on macOS, test first.

## Release numbers (next.8)

- Gate on head 4fb62aa6: `gate --all` exit 0. v2-unit 1914 pass, 0 fail, 17 skip of 1931. Live 1 of 30 ran. Fix rounds: 1.
- Tag v2.0.0-next.8 on 4fb62aa6. release.yml run 40611388019 green (rollback skipped, as expected). npm publish step ended 01:10:17Z, GitHub prerelease created after it by job order (github-release needs publish-npm); the registry `time` field for the version reads 01:11:55Z, 81 s after the GitHub release timestamp (01:10:34Z). Cause of that registry delay not found.
- `latest` stays 1.0.169; GitHub release v1.0.169 is still Latest.

## How to test it

npm way:

```sh
npm i -g context-mode@next
context-mode setup
context-mode doctor
```

Claude Code native way:

```
/plugin marketplace add mksglu/context-mode#release
/plugin install context-mode@context-mode
```

## Per agent

Bytes are one large tool result (about 200 KB log): without context-mode -> with v2.
"Live" means a real model turn ran. "Doc-verified" means the hook shape was checked, but no model turn ran.
The Claude Code, Pi and OpenCode rows are from next.6 and were not re-tested for next.7.

| Agent | Pass | Live or doc-verified | Bytes off -> v2 | Problems |
|---|---|---|---|---|
| Claude Code (next.6) | yes | live | 2,312 -> 226 | None reported. |
| Codex | yes | live | 16,596 -> 1,091 | Off figure is the rollout size, cut by codex to 16,399 bytes for the cat call. Full size is 200,013 bytes in the --json stream. Doctor shows WARN hook-seen until one tool call runs. |
| Gemini CLI | yes | doc-verified | 200,097 -> 168 | No live run, no login. A BeforeAgent payload with a cwd that is not a git repo made the hook print `NO_GIT_DIR` and exit 0. Probably my fake cwd. Hooks may not run outside a git repo. |
| Qwen Code | no | doc-verified | 207,035 -> 425 | skills/ctx-stats/SKILL.md names two tool names. The host tool is `mcp__context-mode__ctx_stats` only. That breaks one channel. Hook-seen is WARN. |
| Copilot CLI | yes | doc-verified | 189,670 -> 382 | No live session, no login. Hook-seen is WARN. Setup plus host CLI install took about 3 minutes. |
| OpenCode (next.6) | yes | doc-verified | 200,115 -> 250 | Not installed, so no model call. Doc not fetched. |
| Pi (next.6) | yes | doc-verified | 192,021 -> 119 | No live model (needs provider login). The tool_call hook did not block `cat`. |
| VS Code (Copilot) | yes | doc-verified | 219,930 -> 112 | No output for a PreToolUse `curl` or `cat` payload. hook.mjs maps `run_in_terminal` to Bash but not `runTerminalCommand`. Real name not confirmed. |
| Kiro | no | doc-verified | 183,414 -> 400 | Kiro CLI not installed. The hook names the tool `mcp_context-mode_ctx_execute`. Kiro docs do not say how a hyphen in the server name is changed. skillOk is false. |
| ZCode | no | doc-verified | 200,036 -> 436 | ZCode CLI not installed. Documented name is `mcp__<server>__<tool>` and the repo already matches. skillOk is false and the cause is open. |

## Fixes in this release

- VS Code: the decoder (src/adapters/vscode.ts) now reads the camelCase payload. It no longer fails silently. Docs show both snake_case and camelCase shapes and name no VS Code version.
- Kiro: the decoder and tool names now match the Kiro docs (PascalCase event names). The skill text is not confirmed, because the MCP name for a hyphen server is not documented.
- ZCode: no behaviour change. The prefix already equals the documented name. The new test was green on first run, so it did not go red. No code bug found behind skillOk=false.
- Codex: setup now writes `default_tools_approval_mode = "approve"` in `[mcp_servers.context-mode]`, next to `omit_tools_from`. The live run on codex 0.156.1 accepted it. `codex mcp list` showed the entry enabled.

## Open items

- Windows: a logged-in host session never ran, so doctor `hook-seen` stays WARN. vscode, kiro and zcode cannot be installed on a runner (config-level proof only).
- Windows: opencode keeps a stale plugin path after a package move (no agent flag in the plugin list; D-WIN-HOOKMERGE-1).
- Windows: `e2e/checks/windows-grandchild-kill.mjs` failed once on a 2 s close budget (run 40590253825) and in the next.6 release run; root cause not found, budget not changed.
- Timing: `[r3] units/222KB` (50 ms budget) failed once under full-suite load on a laptop (91 ms), passes alone and on rerun; budget not changed.
- Registry `time` for a version can lag the publish step by about 80 s; the GitHub release can look earlier than npm in the registry.
