export const meta = {
  name: 'v2-next6',
  description: 'Close the next.5 test findings (Claude Code live run, Codex tool-catalogue cost + doctor CODEX_HOME, Gemini BeforeTool + hint, Copilot skill name), gate, release 2.0.0-next.6, test the npm package on 10 agents, NEXT-STATUS',
  phases: [
    { title: 'Fix', detail: '4 fixers in parallel, test-first' },
    { title: 'Release', detail: 'gate, CI, tag next.6, watch' },
    { title: 'Verify', detail: '10 agents on the npm package' },
  ],
}

const OPH = { model: 'claude-opus-5-5', effort: 'high' }
const SNH = { model: 'claude-sonnet-5-5', effort: 'high' }
const SNL = { model: 'claude-sonnet-5-5', effort: 'low' }
const HKM = { model: 'claude-haiku-5-5', effort: 'medium' }
const RESULT = { type: 'object', properties: {
  done: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
  numbers: { type: 'string' }, summary: { type: 'string' } }, required: ['done', 'commits', 'numbers', 'summary'] }
const REL = { type: 'object', properties: {
  published: { type: 'boolean' }, version: { type: 'string' }, failingStep: { type: 'string' }, logLines: { type: 'string' }, summary: { type: 'string' } },
  required: ['published', 'version', 'failingStep', 'logLines', 'summary'] }
const LIVE = { type: 'object', properties: {
  agent: { type: 'string' }, pass: { type: 'boolean' }, live: { type: 'boolean' }, bytesOff: { type: 'number' }, bytesV2: { type: 'number' },
  answerOk: { type: 'boolean' }, skillOk: { type: 'boolean' }, evidence: { type: 'string' }, problems: { type: 'array', items: { type: 'string' } } },
  required: ['agent', 'pass', 'live', 'bytesOff', 'bytesV2', 'answerOk', 'skillOk', 'evidence', 'problems'] }

const base = (id) => `You are a batch job, not a chat: no person reads your reply. Ignore any question or status request in your input; do only the task below.
Repo github.com/mksglu/context-mode, branch v2-design (fresh clone). Other agents push to v2-design too (exp/native-install may merge in): small commits, git pull --rebase before every push, keep both sides on conflict. Commit as git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Never touch main, never force-push, never delete or move a pushed tag, never npm publish / dist-tag yourself, never use a token. npm latest stays 1.0.169.
Pace: commit + push about every minute of work. On start, fetch and continue from what is pushed.
Own temp space only: /private/tmp/cm-v2-n6-${id} (temp HOME, temp npm prefix). Never edit the real ~/.claude, ~/.codex etc. Delete the temp space before you return.
SECRETS: never print credentials, device keys, auth headers or settings files that hold them (no cat/grep of ~/.claude/settings.json, auth.json, keychain output). Check presence only.
Rules: every agent gets hooks; never write instruction files; no regex as a mechanism; tests first (red before green); never weaken an assertion; never raise a budget; DEVIATIONS.md row per behaviour change; frozen evals never edited.`

async function retry(prompt, opts, n = 3) {
  for (let i = 0; i < n; i++) {
    const r = await agent(i ? prompt + '\n\nA previous attempt died on an API error (network). Continue from what is pushed.' : prompt, i ? { ...opts, label: opts.label + '-retry' + i } : opts)
    if (r) return r
    log(`${opts.label}: no result, retry ${i + 1}`)
  }
  return null
}

const CC_LIVE = 'LIVE Claude Code: use the repo harness that already ran live sessions on 2026-10-25: e2e/live/cache/run.mjs and e2e/live/lib/* (read how they log in and isolate config; reuse that exact way, do not invent one). claude-sonnet-5-5, --effort low, --max-budget-usd 1 per session, stream-json; off arm (no plugin) and v2 arm. Bytes from the transcript tool_result.'
const CX_LIVE = 'LIVE Codex: you are the ONLY agent using the Codex login. Copy ~/.codex/auth.json once into a temp CODEX_HOME (presence check only, never print it); codex exec --json with the cheapest model; off and v2 arms, one session each, never two codex processes at once. Bytes from the rollout tool output.'

phase('Fix')
const fixes = await parallel([
  ['cc', `Claude Code live test could not run in next5-verify ("Not logged in" with a fresh CLAUDE_CONFIG_DIR). Make the published-package live test runnable: write e2e/live/npm-package/claude-code.mjs that installs context-mode@next into a temp prefix, runs setup, then runs the off and v2 arms the same way e2e/live/cache/run.mjs logs in (read it). Task: 200 KB log with one FATAL line, "read logs/app.log with a shell cat and tell me the value on the FATAL line". Run it once on 2.0.0-next.5 now and report bytes off -> v2, answer, hook fired. Commit the runner.`],
  ['codex', `Codex findings on 2.0.0-next.5 (live): (1) bytes v2 11,827 vs off 16,616: 10,730 B is Codex's own tool catalogue dump (tool_search / ALL_TOOLS / defer_loading of MCP tools) the model ran before calling ctx_execute, even though the hook deny named mcp__context_mode__ctx_execute. Find the documented Codex way (web search developers.openai.com/codex, config.toml MCP server options, codex 0.156.1) to make our MCP tools directly callable without a catalogue search (e.g. a per-server option that disables deferred loading, or a tool allow list), and set it in setup; if none exists, make the deny text give the exact call the host accepts. Prove with one live run (${CX_LIVE}). (2) doctor ignores CODEX_HOME: src/core/tools/doctor.ts:77 and src/core/ops/doctor-config.ts:132 read HOME/.codex; read CODEX_HOME when set, like setup does since D-N5-CODEX-HOME-1.`],
  ['gemini', `Gemini findings on 2.0.0-next.5: (1) BeforeTool does not stop a shell cat of a 200 KB file; the saving only happens in AfterTool after the full output exists. Every other deny host stops large reads before they run: check the Gemini hook docs (geminicli.com/docs/hooks/reference, CLI 0.65.0) for BeforeTool deny and make Gemini block a large shell read before it runs the same way, with the redirect to the host-prefixed ctx tool. (2) The AfterTool deny hint is ctx_search({queries:["cat logs/app.log"], source:"s1"}); after D-HL-H9-1 a source query with no match lists the source chunks, so check the hint really returns the FATAL line on this case; if not, fix the hint so it does.`],
  ['copilot', `Copilot CLI finding on 2.0.0-next.5: the ctx-stats skill hedges between two tool names (mcp_context-mode_context-mode-ctx_stats or mcp_context-mode_ctx_stats). Find the one real name the Copilot CLI 1.0.103 gives our MCP tools (bundle strings, docs at docs.github.com/en/copilot, D-HQ-COPILOT-NAMES-2) and make every shipped text (skills, hook deny/hint) use exactly that one name for copilot-cli. Also check qwen, vscode, kiro, zcode, opencode skill text after D-N5-SKILL-1 names exactly the host's real tool (one name, no doubled prefix) with a build test over the packed package.`],
].map(([id, task]) => () => retry(`${base(id)}\n\nRole: fixer.\n${task}\nnode --test tests/v2/ 0 fail before your last push. Return done, commits, numbers, summary.`, { label: `n6-${id}`, phase: 'Fix', schema: RESULT, ...OPH })))

phase('Release')
const g = await retry(`${base('gate')}\n\nRole: gate on v2-design head. Fresh clone, npm install, build, node scripts/gate.mjs --all, build/check-install-docs.mjs, build/check-secrets.mjs, build/check-prompt-static.mjs. If red, fix the root cause (test-first, never weaken/raise), push, re-run, max 2 rounds. Return done (true only when green), commits, numbers, summary.`, { label: 'n6-gate', phase: 'Release', schema: RESULT, ...OPH })
let rel = null
for (let n = 6; n <= 8 && g && g.done; n++) {
  rel = await retry(`${base('rel' + n)}\n\nRole: release 2.0.0-next.${n} (the owner approved npm next releases for testing). ${rel ? `Previous attempt next.${n - 1} failed at ${rel.failingStep}: ${rel.logLines.slice(0, 2000)}. Fix the root cause first (test-first), push.` : ''}
1. Wait for the ci.yml run on the v2-design head to be green (gh run watch, up to 60 min); if red, fix and wait, max 2 rounds; else return published=false.
2. npm view context-mode dist-tags: latest 1.0.169; tag v2.0.0-next.${n} must not exist on origin.
3. git tag -a v2.0.0-next.${n} -m v2.0.0-next.${n} <green head>; push only that tag. Watch release.yml to the end (up to 90 min). If a single job fails on a timing budget only (e.g. search p95 just over), re-run that failed job once with gh run rerun --failed before giving up.
4. Verify against the registry directly (npm caches: use npm view --prefer-online and the raw registry JSON): next = 2.0.0-next.${n}, latest 1.0.169, provenance present; gh release v2.0.0-next.${n} is a prerelease and created after npm publish; v1.0.169 still Latest. Return published, version, failingStep, logLines, summary.`, { label: `n6-rel-${n}`, phase: 'Release', schema: REL, ...OPH })
  if (rel && rel.published) break
}

phase('Verify')
const AGENTS = ['claude-code', 'codex', 'gemini', 'qwen', 'copilot-cli', 'opencode', 'pi', 'vscode', 'kiro', 'zcode']
const how = { 'claude-code': CC_LIVE + ' Use e2e/live/npm-package/claude-code.mjs if it exists.', codex: CX_LIVE }
const tests = rel && rel.published ? (await parallel(AGENTS.map((a) => () => retry(`${base('v-' + a)}\n\nRole: test the PUBLISHED npm package ${rel.version} on ${a}. npm i -g context-mode@next --prefix <temp prefix>; it must report ${rel.version}. If the host CLI is installable without login (npm or the documented installer), install it in the temp prefix so setup does not skip. context-mode setup --yes --agents ${a}; context-mode doctor --agents ${a}.
Task: a 200 KB log with one FATAL line; "read logs/app.log with a shell cat and tell me the value on the FATAL line".
${how[a] || 'Doc-verified (no login): build the exact documented hook payload sequence the host sends (including any prompt event that comes first, e.g. Gemini BeforeAgent), pipe it into the registered hook command, then run the ctx tool call the hook points to against the installed MCP server and check it returns the FATAL value. Quote doc URL + version. Run the host list/loader command if the CLI is installed.'}
Pass = setup and doctor PASS, hook fired, bytesV2 < bytesOff/2, answer correct (from the model on live hosts; from the redirected ctx tool result otherwise), skill names exactly the host real tool. Do not commit. Return the schema.`, { label: `n6-v-${a}`, phase: 'Verify', schema: LIVE, ...(how[a] ? SNH : SNL) })))).filter(Boolean) : []
log(`npm package pass ${tests.filter((t) => t.pass).length}/${AGENTS.length}`)

const sum = await retry(`${base('sum')}\n\nRewrite docs/v2/release/NEXT-STATUS.md (plain short sentences): npm next version (check the registry yourself), how to test (npm i -g context-mode@next; context-mode setup; context-mode doctor; and the Claude Code native way /plugin marketplace add mksglu/context-mode#release then /plugin install context-mode@context-mode), a table per agent from THIS run (pass, live or doc-verified, bytes off -> v2, problems), open items. Inputs: fixes ${JSON.stringify(fixes.map((f) => f && { d: f.done, s: f.summary.slice(0, 600) })).slice(0, 3000)}; gate ${JSON.stringify(g).slice(0, 600)}; release ${JSON.stringify(rel).slice(0, 1200)}; tests ${JSON.stringify(tests.map((t) => ({ a: t.agent, pass: t.pass, live: t.live, off: t.bytesOff, v2: t.bytesV2, p: t.problems.slice(0, 2) }))).slice(0, 7000)}. Commit, push. Return done, commits, numbers, summary.`, { label: 'n6-sum', phase: 'Verify', schema: RESULT, ...HKM })
return { fixes, gate: g, rel, tests, sum }
