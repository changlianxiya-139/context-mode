# Status of the next channel

Checked 2026-10-27 with `npm view context-mode dist-tags --prefer-online`.

## npm version on next

`next` is 2.0.0-next.7. `latest` is still 1.0.169.

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

## Gate and release numbers

- Gate on head 397cc04b: `gate --all` exit 0. v2-unit 1690 pass, 0 fail, 5 skip of 1695. Live 0 of 30 ran (no case covers the changed files, ADR-0012). Fix rounds: 0.
- Release: 2.0.0-next.7 published from head f61b6973 with tag `next` and provenance. GitHub release v2.0.0-next.7 is a prerelease. `latest` stays 1.0.169.

## Open items

- Live arms: 0 of 30 ran in the gate, because no case covers the changed files.
- Windows grandchild-kill test failed once in the next.6 release run and passed on rerun. Root cause not found.
- ZCode: skillOk=false on next.6 and next.7. Cause open. Needs a real host.
- Kiro: MCP tool name for a hyphen server is not confirmed. Needs a real host.
- VS Code: confirm whether the real tool name is `run_in_terminal` or `runTerminalCommand`.
- Qwen: ctx-stats skill names two tool names. Keep only `mcp__context-mode__ctx_stats`.
- Gemini: check that hooks work outside a git repo.
- Copilot CLI: tool name form not verified on a real host.
- Codex: a large shell read is not caught in `codex exec`.
- Eight agents have no live model session.
- Hosts not installed: Kiro, ZCode, OpenCode.
- GitHub prerelease v2.0.0-next.4 has no npm package.
- Setup skips qwen when qwen is not on PATH. It should use the native install.
