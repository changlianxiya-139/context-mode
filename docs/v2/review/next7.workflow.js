export const meta = {
  name: 'v2-next7',
  description: 'Close the next.6 red hosts (vscode payload shape, kiro camelCase events + shell tool name, zcode skill name, codex exec MCP approval), gate, release 2.0.0-next.7 (also ships qwen D-HQ-SKILLS-3 and copilot D-HQ-COPILOT-NAMES-3), re-test the changed hosts on the npm package, NEXT-STATUS',
  phases: [
    { title: 'Fix', detail: '4 fixers in parallel, test-first' },
    { title: 'Release', detail: 'gate, CI, tag next.7, watch' },
    { title: 'Verify', detail: 'changed hosts on the npm package' },
  ],
}

const SNH = { model: 'claude-sonnet-5-5', effort: 'high' }
const SNL = { model: 'claude-sonnet-5-5', effort: 'low' }
const OPH = { model: 'claude-opus-5-5', effort: 'high' }
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
Repo github.com/mksglu/context-mode, branch v2-design (fresh clone). Other agents push too: small commits, pull --rebase before every push, keep both sides on conflict; push after each finished file, at least every 3 minutes. Commit as git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Never touch main, never force-push, never delete or move a pushed tag, never npm publish / dist-tag yourself, never use a token. npm latest stays 1.0.169.
Own temp space only: /private/tmp/cm-v2-n7-${id} (temp HOME, temp prefix). Never edit the real ~/.claude, ~/.codex, ~/.copilot, ~/.kiro etc. SECRETS: never print credentials, device keys, auth headers or files that hold them; presence checks only. Delete the temp space before you return.
Rules: every agent gets hooks; never write instruction files; one channel per agent, no fallback paths; no regex as a mechanism; tests first (red before green); never weaken an assertion; never raise a budget; DEVIATIONS.md row per behaviour change; frozen evals never edited. Unit tests need: npm install --no-package-lock, node build/build.mjs --generated-only. node --test tests/v2/ 0 fail before the last push.`

async function retry(prompt, opts, n = 3) {
  for (let i = 0; i < n; i++) {
    const r = await agent(i ? prompt + '\n\nA previous attempt died on an API error. Continue from what is pushed.' : prompt, i ? { ...opts, label: opts.label + '-retry' + i } : opts)
    if (r) return r
    log(`${opts.label}: no result, retry ${i + 1}`)
  }
  return null
}

phase('Fix')
const fixes = await parallel([
  ['vscode', 'VS Code (agent hooks, ~/.copilot/hooks/context-mode-vscode.json): on next.6 a camelCase payload (hookEventName) was rejected "unknown hook event undefined" and the hook exited 0 with empty output, so it would silently do nothing. Find the documented VS Code agent hook payload (code.visualstudio.com docs on agent hooks; quote URL and VS Code version) and the field names it really sends; make the vscode decoder accept exactly that shape. A decoder that cannot read the event must not exit silently: follow the existing decode-failure rule of the other hosts. Red test with the documented payload first.'],
  ['kiro', 'Kiro CLI: on next.6 the decoder rejected camelCase events ("kiro: unknown hook event preToolUse"); the registered shell matcher is "shell" but the decoder only treats execute_bash as the shell tool, so a payload with tool_name shell passed silently. Find the documented Kiro CLI hook event names and tool names (kiro.dev docs; quote URL and version) and make the decoder and the registered matchers agree with them exactly. Red test with the documented payloads first. Also check the kiro skill text names the real Kiro tool name (skillOk was false).'],
  ['zcode', 'ZCode: on next.6 skillOk was false: the skills name a tool form that does not match the documented ZCode MCP tool name. Find the documented ZCode tool naming (quote URL); make the zcode skill render, the toolNamePrefix in src/adapters/table.ts and the hook texts use exactly that name. Extend tests/v2/build/host-skills.test.mjs red first.'],
  ['codex', 'Codex exec: on next.6 the redirected ctx_execute call failed with "MCP tool call requires approval, but approval policy is never", so the model fell back to rg. The Codex plugin mcp.json already sets default_tools_approval_mode approve; the setup path (config.toml [mcp_servers.context-mode]) must set the documented per-server approval key the same way so our own read-only ctx tools never need approval. Verify the key name in the codex-rs source at the installed version (codex --version) and with codex mcp list; red test first (print-codex golden + setup test); prove with one live codex exec run (you are the only agent using the Codex login: copy ~/.codex/auth.json once into a temp CODEX_HOME, never print it).'],
].map(([id, task]) => () => retry(`${base(id)}\n\nRole: fixer.\n${task}\nReturn done, commits, numbers, summary.`, { label: `n7-${id}`, phase: 'Fix', schema: RESULT, ...SNH })))

phase('Release')
const g = await retry(`${base('gate')}\n\nRole: gate on v2-design head. Fresh clone, npm install, build, node scripts/gate.mjs --all, build/check-install-docs.mjs, build/check-secrets.mjs, build/check-prompt-static.mjs. If red, fix the root cause (test-first, never weaken/raise), push, re-run, max 2 rounds. Return done (true only when green), commits, numbers, summary.`, { label: 'n7-gate', phase: 'Release', schema: RESULT, ...SNH })
let rel = null
for (let n = 7; n <= 9 && g && g.done; n++) {
  rel = await retry(`${base('rel' + n)}\n\nRole: release 2.0.0-next.${n} (the owner approved npm next releases for testing). ${rel ? `Previous attempt next.${n - 1} failed at ${rel.failingStep}: ${rel.logLines.slice(0, 2000)}. Fix the root cause first (test-first), push.` : ''}
1. Wait for the ci.yml run on the v2-design head to be green (gh run watch, up to 60 min); if red, fix and wait, max 2 rounds; else return published=false.
2. npm view context-mode dist-tags: latest 1.0.169; tag v2.0.0-next.${n} must not exist on origin.
3. git tag -a v2.0.0-next.${n} -m v2.0.0-next.${n} <green head>; push only that tag. Watch release.yml to the end (up to 90 min). If a single job fails only on a timing budget or a known flaky Windows test, re-run that failed job once with gh run rerun --failed before giving up.
4. Verify against the raw registry JSON (npm caches): next = 2.0.0-next.${n}, latest 1.0.169, provenance present; gh release v2.0.0-next.${n} is a prerelease created after npm publish; v1.0.169 still Latest. Return published, version, failingStep, logLines, summary.`, { label: `n7-rel-${n}`, phase: 'Release', schema: REL, ...OPH })
  if (rel && rel.published) break
}

phase('Verify')
const AGENTS = ['vscode', 'kiro', 'zcode', 'codex', 'qwen', 'copilot-cli', 'gemini']
const CX = 'LIVE Codex: you are the ONLY agent using the Codex login. Copy ~/.codex/auth.json once into a temp CODEX_HOME (never print it); codex exec --json with the cheapest model; off and v2 arms, one session each, never two codex processes at once. Bytes from the rollout tool output. The redirected ctx tool call must succeed (no approval error).'
const tests = rel && rel.published ? (await parallel(AGENTS.map((a) => () => retry(`${base('v-' + a)}\n\nRole: test the PUBLISHED npm package ${rel.version} on ${a}. npm i -g context-mode@next --prefix <temp prefix>; it must report ${rel.version}. If the host CLI installs without login, install it in the temp prefix. context-mode setup --yes --agents ${a}; context-mode doctor --agents ${a}.
Task: a 200 KB log with one FATAL line; "read logs/app.log with a shell cat and tell me the value on the FATAL line".
${a === 'codex' ? CX : 'Doc-verified (no login): web search the host hook docs and quote URL + version; build the exact documented payload sequence (field names and casing as documented), pipe it into the registered hook command, then run the ctx tool call the hook points to against the installed MCP server and check it returns the FATAL value. Run the host list/loader command if the CLI is installed.'}
Pass = setup and doctor PASS, hook fired on the documented payload, bytesV2 < bytesOff/2, answer correct, skill names exactly the host real tool. Do not commit. Return the schema.`, { label: `n7-v-${a}`, phase: 'Verify', schema: LIVE, ...(a === 'codex' ? SNH : SNL) })))).filter(Boolean) : []
log(`npm package pass ${tests.filter((t) => t.pass).length}/${AGENTS.length}`)

const sum = await retry(`${base('sum')}\n\nUpdate docs/v2/release/NEXT-STATUS.md (plain short sentences): npm next version (check the registry yourself), the per-agent table (keep the next.6 rows for claude-code, pi, opencode; replace the rows re-tested here), fixes in this release, open items. Inputs: fixes ${JSON.stringify(fixes.map((f) => f && { d: f.done, s: f.summary.slice(0, 500) })).slice(0, 2500)}; gate ${JSON.stringify(g).slice(0, 500)}; release ${JSON.stringify(rel).slice(0, 1000)}; tests ${JSON.stringify(tests.map((t) => ({ a: t.agent, pass: t.pass, live: t.live, off: t.bytesOff, v2: t.bytesV2, p: t.problems.slice(0, 2) }))).slice(0, 6000)}. Commit, push. Return done, commits, numbers, summary.`, { label: 'n7-sum', phase: 'Verify', schema: RESULT, ...SNL })
return { fixes, gate: g, rel, tests, sum }
