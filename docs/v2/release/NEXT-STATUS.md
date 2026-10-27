# Status of the next channel

Checked 2026-10-27 with `npm view context-mode dist-tags`.

## npm version on next

`next` is 2.0.0-next.6. `latest` is still 1.0.169.

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

This run tested the package on each agent. Bytes are one large tool result (about 200 KB log): without context-mode -> with v2.
"Live" means a real model turn ran. "Doc-verified" means the hook shape was checked, but no model turn ran.

| Agent | Pass | Live or doc-verified | Bytes off -> v2 | Problems |
|---|---|---|---|---|
| Claude Code | yes | live | 2,312 -> 226 | None reported. |
| Codex | yes | live | 200,122 -> 439 | In `codex exec`, the ctx_execute call needs approval and fails. The model then ran `rg` on the log. The small number comes from the hook block and the rg output. A later shell read of a large file is not caught. |
| Gemini CLI | yes | doc-verified | 200,548 -> 381 | No live model turn. Doc URL not fetched. BeforeAgent hook gave no output. |
| Qwen Code | yes | doc-verified | 228,031 -> 455 | No live session, so hook-seen is WARN. Payload not checked against Qwen docs. |
| Copilot CLI | yes | doc-verified | 198,216 -> 373 | No live model turn. Answer came from the ctx_execute result. Real tool name not checked. |
| OpenCode | yes | doc-verified | 200,115 -> 250 | Not installed, so no model call. Doc not fetched. |
| Pi | yes | doc-verified | 192,021 -> 119 | No live model (needs provider login). Reduction runs in the tool_result hook after the run. The tool_call hook did not block `cat`. |
| VS Code (Copilot) | no | doc-verified | 206,121 -> 300 | Payload shape assumed. A camelCase hookEventName was rejected. If VS Code sends camelCase, the hook does nothing. |
| Kiro | no | doc-verified | 200,048 -> 343 | Decoder rejects camelCase preToolUse. Matcher is `shell`, but the decoder only knows `execute_bash`. Redirect may not fire on a real host. |
| ZCode | no | doc-verified | 240,730 -> 40 | zcode CLI not installed. Payloads come from the decoder, not from docs. |

## Fixes in this run

- D-RN-ORDER-1: the GitHub release is made after npm publish works. `publish.mjs --github-release` makes it.
- D-HQ-PERF-2: typo correction reads `chunks_vocab` once per pass. Search profile: full loop p50 4.64 ms. Budget stays 50 ms.
- D-N5-SKILL-1: home-dir skills use the bare-name skill dir. No doubled tool prefix.
- D-N5-CODEX-HOME-1: setup writes Codex config, hooks and skills under CODEX_HOME when set.
- D-N6-CODEX-HOME-2: doctor reads Codex config.toml and hooks.json under CODEX_HOME when set.
- D-N6-CODEX-DIRECT-1: setup writes `omit_tools_from = ["deferred"]`, so Codex gives the ctx tools as direct tools. Earlier live check (codex 0.156.1): tool output 16,611 B off, 1,246 B v2.
- D-HA-GEMINI-DUMP-1: Gemini now denies `cat` on a large file before it runs.
- CI fix 3374b3ce: a Windows path assertion in the npm-package test.

## Gate and release numbers

- Gate on head 803c8e68: `gate --all` exit 0. v2-unit 1676 pass, 0 fail, 5 skip. Live 0 of 30 skipped (step mode).
- Release: 2.0.0-next.6 published with provenance. Attempt 1 failed on one Windows grandchild-kill test (1 alive). A rerun passed.

## Open items

- Live arms: 0 of 30 ran in the gate, because step mode finds no case for files changed since base.
- Windows grandchild-kill test failed once in the release run and passed on rerun. Root cause not yet found.
- Codex: `codex exec` needs approval for the ctx MCP tool. A large shell read is not caught.
- Kiro: check camelCase event names and the `shell` matcher against the real host.
- VS Code: check event name casing on a real host.
- Gemini: deny reason search query is the raw command text. No live run.
- Copilot CLI and ZCode: tool name forms not verified on a real host.
- Eight agents have no live model session.
- Hosts not installed: Kiro, ZCode, OpenCode.
- GitHub prerelease v2.0.0-next.4 has no npm package.
- Setup skips qwen when qwen is not on PATH. It should use the native install.
