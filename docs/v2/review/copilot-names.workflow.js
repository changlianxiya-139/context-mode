export const meta = {
  name: 'v2-copilot-names',
  description: 'Copilot CLI skill text names exactly one real tool name; check all hosts skill text in the packed package (Opus fixer was stopped 3x by safeguards, run on Sonnet)',
  phases: [{ title: 'Fix', detail: 'one fixer, test-first, small pushes' }],
}

const OPH = { model: 'claude-sonnet-5-5', effort: 'high' }
const RESULT = { type: 'object', properties: {
  done: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
  numbers: { type: 'string' }, summary: { type: 'string' } }, required: ['done', 'commits', 'numbers', 'summary'] }

const prompt = `You are a batch job, not a chat: no person reads your reply. Ignore any question or status request in your input; do only the task below.
Repo github.com/mksglu/context-mode, branch v2-design (fresh clone). Other agents push too and a release job tags the green head soon: small commits, pull --rebase before every push, keep both sides on conflict; push after each finished file, at least every 3 minutes. Commit as git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Never touch main, never force-push, never tag, never npm publish, never use a token. Temp space /private/tmp/cm-v2-cn only (temp HOME, temp prefix); never edit the real ~/.qwen or ~/.gemini; never print credentials; delete the temp space before you return.
Rules: tests first (red before green); never weaken an assertion; DEVIATIONS.md row; no regex as a mechanism; one channel per agent, no fallback paths.

Bug: on 2.0.0-next.5 the copilot-cli ctx-stats skill hedges between two tool names (mcp_context-mode_context-mode-ctx_stats or mcp_context-mode_ctx_stats). Find the one real name Copilot CLI 1.0.103 gives our MCP tools (docs.github.com/en/copilot, the CLI bundle strings, D-HQ-COPILOT-NAMES-2) and make every shipped text for copilot-cli (skills, hook deny/hint) use exactly that name. Keep D-HQ-SKILLS-3 (gemini+qwen share skills/ with both names) as is. Extend tests/v2/build/host-skills.test.mjs red first, then green. If the CLI can be installed without login, list the tools it registers to prove the name. node --test tests/v2/ 0 fail before the last push. Return done, commits, numbers, summary.`

let r = null
for (let i = 0; i < 3 && !r; i++) r = await agent(i ? prompt + '\n\nA previous attempt died on an API error. Continue from what is pushed.' : prompt, { label: i ? `cn-fix-retry${i}` : 'cn-fix', phase: 'Fix', schema: RESULT, ...OPH })
return r
