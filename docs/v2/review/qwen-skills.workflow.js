export const meta = {
  name: 'v2-qwen-skills',
  description: 'Native qwen extension install loads skills from <extension>/skills, which holds the Gemini render (mcp_context-mode_ prefix); Qwen names tools mcp__context-mode__. Give qwen its own rendered skills dir its manifest points at, test-first, before next.6 is tagged',
  phases: [{ title: 'Fix', detail: 'one fixer, test-first, small pushes' }],
}

const OPH = { model: 'claude-sonnet-5-5', effort: 'high' }
const RESULT = { type: 'object', properties: {
  done: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
  numbers: { type: 'string' }, summary: { type: 'string' } }, required: ['done', 'commits', 'numbers', 'summary'] }

const prompt = `You are a batch job, not a chat: no person reads your reply. Ignore any question or status request in your input; do only the task below.
Repo github.com/mksglu/context-mode, branch v2-design (fresh clone). Other agents push too and a release job tags the green head soon: small commits, pull --rebase before every push, keep both sides on conflict; push after each finished file, at least every 3 minutes. Commit as git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Never touch main, never force-push, never tag, never npm publish, never use a token. Temp space /private/tmp/cm-v2-qs only (temp HOME, temp prefix); never edit the real ~/.qwen or ~/.gemini; never print credentials; delete the temp space before you return.
Rules: tests first (red before green); never weaken an assertion; DEVIATIONS.md row; no regex as a mechanism; one channel per agent, no fallback paths.

Bug: a native "qwen extensions install" (Qwen Code 0.26.1) loads skills from <extension>/skills. That dir holds Gemini's render (mcp_context-mode_ctx_*). Qwen's real tool names are mcp__context-mode__ctx_* (see the qwen toolNamePrefix in src/adapters/table.ts). Fix at the root the way D-HQ-SKILLS-2 did for claude-code: build renders the 3 skills for qwen into its own dir from the single skills/ source (split/join), and the qwen extension manifest points at it per the Qwen extension docs (web search; quote URL). If Qwen has no manifest key for a skills path, find the documented way and say so. Extend tests/v2/build/host-skills.test.mjs (packed package, every host's shipped skill text names exactly its own real tool name) red first, then green. Known from a first attempt (2026-10-27): Qwen Code 0.26.1 and its nightly read skills from the fixed path <extensionPath>/skills and ignore a skills key in qwen-extension.json; Gemini CLI 0.65.0 also reads <extension>/skills. So one shared skills/ dir cannot hold two renders. Pick the simplest root fix with evidence, in this order: (a) a host-specific extension root per host if the native install command can target it (e.g. a subdir source form documented by Qwen/Gemini, or the qwen install source suffix :<name> already in docs/install/qwen.md), each root with its own manifest and rendered skills; (b) otherwise a skill text that names the tool the same way on both hosts and that both hosts resolve (prove with each host loader), and update the host-skills test rule for gemini+qwen with a DEVIATIONS row explaining why. Prove live: qwen extensions install <packed package> --consent in a temp HOME, then read the skill text Qwen loads and run context-mode doctor --agents qwen. node --test tests/v2/ 0 fail before the last push. Return done, commits, numbers, summary.`

let r = null
for (let i = 0; i < 3 && !r; i++) r = await agent(i ? prompt + '\n\nA previous attempt died on an API error. Continue from what is pushed.' : prompt, { label: i ? `qs-fix-retry${i}` : 'qs-fix', phase: 'Fix', schema: RESULT, ...OPH })
return r
