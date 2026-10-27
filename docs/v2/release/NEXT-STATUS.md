# Status of the next channel

Checked 2026-10-27 with `npm view context-mode dist-tags`.

## npm version on next

`next` is 2.0.0-next.5 (tag v2.0.0-next.5, commit 0bf57342). `latest` is still 1.0.169.

## How to test it

```sh
npm i -g context-mode@next
context-mode setup
context-mode doctor
```

## Per agent

This run tested the next.5 package on each agent. Only Codex had a live model turn. Claude Code had no login in a fresh config dir, so its live arms did not run.
Bytes are one large tool result (about 200 KB log): without context-mode -> with v2.

| Agent | Pass | Live or doc-verified | Bytes off -> v2 | Problems |
|---|---|---|---|---|
| Claude Code | no | not run (no login) | none | Live arms did not run. doctor WARN: hook-seen not seen yet. |
| Codex | no | live | 16,616 -> 11,827 | v2 is not under half of off. The tool discovery dump (10,730 B) is the cost. Setup ignored CODEX_HOME (fixed, see below). |
| Gemini CLI | no | doc-verified | 191,795 -> 145 | Answer not proven without a live model. The deny reason search query is the raw command text. |
| Qwen Code | no | doc-verified | 215,118 -> 302 | Setup skips when qwen is not on PATH, so it does not run the native install. Skill tool name was doubled (fixed). |
| Copilot CLI | no | doc-verified | 185,768 -> 248 | No live turn. Tool name forms in skills and deny reason differ. Real name not checked. |
| VS Code (Copilot) | yes | doc-verified | 200,101 -> 358 (estimate) | No live session. hook-seen stays WARN. |
| Kiro | no | doc-verified | 219,322 -> 188 | No Kiro CLI. Docs lack the tool_response shape. Answer not proven. |
| ZCode | no | doc-verified | 192,625 -> 300 | No zcode CLI. Skill tool name was doubled (fixed). Deny reason name must be checked again. |
| Pi | yes | doc-verified | 185,813 -> 177 | No live model. Extension handlers ran in-process. |
| OpenCode | no | doc-verified | 194,935 -> 175 | opencode not installed. hook-seen WARN. |

## Fixes pushed after next.5

They ship in the next tag.

- D-RN-ORDER-1: the GitHub release is made only after npm publish works. `--promote` makes no release. New mode `--github-release`.
- D-HQ-PERF-2: typo correction reads `chunks_vocab` once per pass. Search profile: full loop p50 4.64 ms, within host noise. Budget stays 50 ms.
- D-N5-SKILL-1: setup builds home-dir skills from the bare-name skill dir. No doubled tool prefix (codex, qwen, copilot-cli, vscode, kiro, zcode, opencode).
- D-N5-CODEX-HOME-1: setup writes the codex config, hooks and skills under CODEX_HOME when set.
- D-N6-CODEX-HOME-2: doctor D3 and D5 read the codex config.toml and hooks.json under CODEX_HOME when set.
- D-N6-CODEX-DIRECT-1: setup writes `omit_tools_from = ["deferred"]` in `[mcp_servers.context-mode]`, so Codex gives the ctx tools as direct tools, with no tool_search. Live check (codex 0.156.1, gpt-5.6-luna low, packed build of this branch, one session per arm, same 220 KB FATAL log task): tool output bytes from the rollout, off 16,611, v2 1,246 (next.5: 11,827). v2 made no tool_search call; calls were ctx_resume, ctx_execute, then one `rg FATAL`. Both arms gave K7-ZETA-4412.

Check after these fixes: `node --test tests/v2/` 1644 pass, 0 fail, 5 skip. `gate --all --quick` exit 0.

## Open items

- GitHub prerelease v2.0.0-next.4 has no npm package.
- Claude Code live run needs a credential step for the fresh config dir.
- Gemini deny reason: with a prompt in the session the FATAL line is in the reason. With no prompt, only the last log line is. Search query text still needs a check.
- Setup skips qwen when it is not installed. It should use the native install.
- Tool-name forms for Copilot CLI and ZCode are not verified on a real host.
- Hosts not installed: Kiro, ZCode, OpenCode, VS Code (not run).
- Live runs with a logged-in model session are missing for 9 agents.
