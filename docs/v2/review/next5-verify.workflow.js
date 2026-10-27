export const meta = {
  name: 'v2-next5-verify',
  description: 'Test the published npm package context-mode@2.0.0-next.5 on all 10 agents (Claude Code + Codex live); fix release order (GitHub release after npm); profile search p95 headroom; rewrite NEXT-STATUS.md with real results',
  phases: [
    { title: 'Verify', detail: '10 agents on the npm package' },
    { title: 'Fix', detail: 'release order, search profile' },
    { title: 'Status', detail: 'NEXT-STATUS.md' },
  ],
}

const OPH = { model: 'claude-opus-5-5', effort: 'high' }
const SNH = { model: 'claude-sonnet-5-5', effort: 'high' }
const SNL = { model: 'claude-sonnet-5-5', effort: 'low' }
const LIVE = { type: 'object', properties: {
  agent: { type: 'string' }, pass: { type: 'boolean' }, live: { type: 'boolean' }, bytesOff: { type: 'number' }, bytesV2: { type: 'number' },
  answerOk: { type: 'boolean' }, skillOk: { type: 'boolean' }, evidence: { type: 'string' }, problems: { type: 'array', items: { type: 'string' } } },
  required: ['agent', 'pass', 'live', 'bytesOff', 'bytesV2', 'answerOk', 'skillOk', 'evidence', 'problems'] }
const RESULT = { type: 'object', properties: {
  done: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
  numbers: { type: 'string' }, summary: { type: 'string' } }, required: ['done', 'commits', 'numbers', 'summary'] }

const base = (id) => `You are a batch job, not a chat: no person reads your reply. Ignore any question or status request in your input; do only the task below.
Repo github.com/mksglu/context-mode, branch v2-design (fresh clone). Commit as git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Never touch main, never force-push, never tag, never npm publish / dist-tag, never use a token. npm latest stays 1.0.169.
Pace: commit + push about every minute; pull --rebase before every push.
Own temp space only: /private/tmp/cm-v2-n5-${id} (temp HOME, temp npm prefix). Never edit the real ~/.claude, ~/.codex etc. Delete the temp space before you return.
Rules: every agent gets hooks; never write instruction files; no regex as a mechanism; tests first (red before green); never weaken an assertion; never raise a budget; DEVIATIONS.md row per behaviour change.`

async function retry(prompt, opts, n = 3) {
  for (let i = 0; i < n; i++) {
    const r = await agent(i ? prompt + '\n\nA previous attempt died on an API error (network). Continue from what is pushed.' : prompt, i ? { ...opts, label: opts.label + '-retry' + i } : opts)
    if (r) return r
    log(`${opts.label}: no result, retry ${i + 1}`)
  }
  return null
}

const AGENTS = ['claude-code', 'codex', 'gemini', 'qwen', 'copilot-cli', 'opencode', 'pi', 'vscode', 'kiro', 'zcode']
const LIVE_HOW = {
  'claude-code': 'LIVE: real claude binary, fresh CLAUDE_CONFIG_DIR with only the login credential (the documented way the gateway sandbox CLAUDE.md describes), --model claude-sonnet-5-5 --effort low, --max-budget-usd 1, stream-json; off arm (no plugin) and v2 arm. Bytes from the transcript tool_result.',
  codex: 'LIVE: you are the ONLY agent using the Codex login. Copy ~/.codex/auth.json once into a temp CODEX_HOME; codex exec --json with the cheapest model; off and v2 arms, one session each, never two codex processes at once. Bytes from the rollout tool output.',
}

phase('Verify')
const tests = (await parallel(AGENTS.map((a) => () => retry(`${base('v-' + a)}\n\nRole: test the PUBLISHED npm package on ${a}. npm i -g context-mode@next --prefix <temp prefix>; it must report 2.0.0-next.5. context-mode setup --yes --agents ${a}; context-mode doctor --agents ${a}.
Task: a 200 KB log with one FATAL line; "read logs/app.log with a shell cat and tell me the value on the FATAL line".
${LIVE_HOW[a] || 'Doc-verified (no login): build the exact documented hook payload (web search the host hook docs, quote URL + version), pipe it into the hook command setup registered, check the output schema and the bytes the model would see. If the host CLI installs without a login, run its list/loader command to prove it parses our files.'}
Pass = setup and doctor PASS, hook fired, bytesV2 < bytesOff/2, answer correct, skill names the host real tool. Do not commit. Return the schema.`,
  { label: `n5-v-${a}`, phase: 'Verify', schema: LIVE, ...(LIVE_HOW[a] ? SNH : SNL) })))).filter(Boolean)
log(`npm package pass ${tests.filter((t) => t.pass).length}/${AGENTS.length}`)

phase('Fix')
const [order, prof] = await parallel([
  () => retry(`${base('order')}\n\nRole: release order fix. Run 40496186557 / next.4 showed the GitHub release is created before npm publish, so a failed npm publish leaves a GitHub prerelease with no npm package (v2.0.0-next.4 exists on GitHub, not on npm). Make release.yml / publish.mjs create the GitHub release only after publish-npm succeeds. Red test first (tests/v2/release), then fix. Do not delete the existing v2.0.0-next.4 GitHub release; list it under open items. node --test tests/v2/release/ 0 fail. Return done, commits, numbers, summary.`, { label: 'n5-order', phase: 'Fix', schema: RESULT, ...OPH }),
  () => retry(`${base('prof')}\n\nRole: profiling. GP-SEARCH/heldout measured search p95 50.5 ms against a 50 ms budget on ubuntu node 26 in run 40496186557 (passed on rerun and in ci.yml). Profile the 1 MB search path (node --cpu-prof, 30+ runs), find the top self-time frames, and cut real work if there is a safe win (test-first, same results, recall@5/MRR unchanged). Never raise the budget. Write the numbers (before/after p50/p95, top frames) into docs/v2/spikes/perf/PROFILE.md. Return done, commits, numbers, summary.`, { label: 'n5-prof', phase: 'Fix', schema: RESULT, ...OPH }),
])

phase('Status')
const red = tests.filter((t) => !t.pass)
let fix = null
if (red.length) fix = await retry(`${base('fix')}\n\nRole: fixer. Hosts red on the published package 2.0.0-next.5: ${JSON.stringify(red).slice(0, 9000)}. Fix each at the root, test-first, node --test tests/v2/ 0 fail, gate --all --quick green, push to v2-design. Do not tag. Return done, commits, numbers, summary.`, { label: 'n5-fix', phase: 'Status', schema: RESULT, ...OPH })
const sum = await retry(`${base('sum')}\n\nRewrite docs/v2/release/NEXT-STATUS.md (plain short sentences; replace the old doc-only table): npm next = 2.0.0-next.5 (check npm view context-mode dist-tags yourself), how to test (npm i -g context-mode@next; context-mode setup; context-mode doctor), a table per agent from THIS run (pass, live or doc-verified, bytes off -> v2, problems), the fixes pushed after next.5 (they ship in the next tag), open items (GitHub prerelease v2.0.0-next.4 with no npm package; anything red). Inputs: tests ${JSON.stringify(tests.map((t) => ({ a: t.agent, pass: t.pass, live: t.live, off: t.bytesOff, v2: t.bytesV2, p: t.problems.slice(0, 2) }))).slice(0, 7000)}; order ${JSON.stringify(order).slice(0, 1200)}; profile ${JSON.stringify(prof).slice(0, 1200)}; fix ${JSON.stringify(fix).slice(0, 1500)}. Commit, push. Return done, commits, numbers, summary.`, { label: 'n5-sum', phase: 'Status', schema: RESULT, ...SNL })
return { tests, order, prof, fix, sum }
