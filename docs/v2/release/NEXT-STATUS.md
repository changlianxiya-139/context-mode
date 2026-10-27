# Status of the next channel

Checked 2026-10-27 with `npm view context-mode dist-tags`.

## npm version on next

There is no `next` tag. The command shows only `latest: 1.0.169`.
2.0.0-next.5 did not publish. Its release run failed in the ci gate (see "Still open").
Nothing from v2 is on npm now. `latest` is still 1.0.169.

## How to test it

Once a next version is published, run:

```sh
npm i -g context-mode@next
context-mode setup
context-mode doctor
```

Until then, build from a clone: see "From source" in `docs/install/README.md`.

## Per agent

Method: doc-verified. No run used a logged-in model session. Each run piped the documented host payload into the installed hook or plugin. Date 2026-10-26.
Data: `docs/benchmarks/hooks-saving/results.json`. Detail: `docs/install/README.md`.
Bytes are one large tool result (about 200 KB log): without context-mode -> with v2.

| Agent | Pass | Live or doc-verified | Bytes off -> v2 | Problems |
|---|---|---|---|---|
| Claude Code | yes | doc-verified (host 2.1.309) | 196,149 -> 286 | none |
| Codex | yes | doc-verified, partly (host 0.164.0) | 217,858 -> 392 | docs page has no skills directory |
| Gemini CLI | yes | doc-verified, partly (host 0.65.0) | 168,875 -> 343 | deny text names `ctx_search`, host name is `mcp_context-mode_ctx_search` |
| Qwen Code | yes | doc-verified, partly (host 0.26.1) | 212,544 -> 332 | no headless hook list |
| Copilot CLI | yes | doc-verified, partly (host 1.0.103) | 203,669 -> 384 | MCP tool-name prefix not checked |
| VS Code (Copilot) | yes | doc-verified, partly (not run) | 204,513 -> 560 | no loader run |
| Kiro | yes | doc-verified, partly (not installed) | 183,551 -> 242 | stdin payload from adapter, not docs |
| ZCode | yes | doc-verified, partly (not installed) | 169,068 -> 443 | skills dir not in docs |
| Pi | yes | doc-verified (host 0.73.1) | 200,062 -> 160 | none |
| OpenCode | yes | doc-verified, partly (not installed) | 198,645 -> 235 | plugin tool name unproven live |

Claude Code A/B (live, `docs/v2/benchmarks.md`): median tool_result bytes on large tasks off 4,694.5, v2 734.5. 12 of 12 pass per arm.

## Still open

- Publish. The next.5 release run 40496186557 failed in the ci gate on ubuntu node 26. GP-SEARCH/heldout search p95 was 50.5 ms, budget 50 ms. Same commit 0bf57342 passed ci.yml run 40494937709. It looks like runner noise. No budget was raised. Next step: push tag v2.0.0-next.6 on a green head, or re-run the failed job.
- The next.4 failure (E422, no `repository` key) is fixed in 496670bf and 0bf57342 (D-RN-REPO-1).
- Live runs with a logged-in model session do not exist for 9 agents.
- Hosts not installed: VS Code (not run), Kiro, ZCode, OpenCode.
- Claude Code needs `context-mode upgrade` after an npm update (see `UPGRADE-CHECK.md`).
- Claude Code A/B: json-1 tokens in v2 stay above off.
