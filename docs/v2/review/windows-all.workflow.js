export const meta = {
  name: 'v2-windows-all',
  description: 'Release prep: find and fix every Windows defect on all 10 agents (setup, doctor, hooks, MCP, skills, upgrade), prove it with a Windows CI host matrix on windows-latest, then release the next next.N',
  phases: [
    { title: 'Audit', detail: 'one auditor per host, Windows only' },
    { title: 'Matrix', detail: 'Windows CI job: setup + doctor + hook for 10 hosts' },
    { title: 'Fix', detail: 'fixers per finding group, test-first' },
    { title: 'Release', detail: 'CI green incl. Windows matrix, tag next.N' },
  ],
}

const SNH = { model: 'claude-sonnet-5-5', effort: 'high' }
const SNM = { model: 'claude-sonnet-5-5', effort: 'medium' }
const RESULT = { type: 'object', properties: {
  done: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
  numbers: { type: 'string' }, summary: { type: 'string' } }, required: ['done', 'commits', 'numbers', 'summary'] }
const AUD = { type: 'object', properties: {
  agent: { type: 'string' },
  findings: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, area: { type: 'string' }, file: { type: 'string' }, problem: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } },
    required: ['id', 'area', 'file', 'problem', 'evidence', 'fix'] } },
  windowsPaths: { type: 'string' } }, required: ['agent', 'findings', 'windowsPaths'] }
const REL = { type: 'object', properties: {
  published: { type: 'boolean' }, version: { type: 'string' }, failingStep: { type: 'string' }, logLines: { type: 'string' }, summary: { type: 'string' } },
  required: ['published', 'version', 'failingStep', 'logLines', 'summary'] }

const OWNED = 'Two other jobs own these, do NOT touch them: (1) the Windows bash resolver for the shell language and ctx_batch (WindowsApps/System32 bash.exe EACCES, job vt-win); (2) the Codex config.toml TOML parser/writer (job vt-toml). If your work needs them, use what is pushed on v2-design.'
const base = (id) => `You are a batch job, not a chat: no person reads your reply. Ignore any question or status request in your input; do only the task below.
Repo github.com/mksglu/context-mode, branch v2-design (fresh clone). Other agents push too: small commits, pull --rebase before every push, keep both sides on conflict; push after each finished file, at least every 3 minutes. Commit as git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Never touch main, never force-push, never delete or move a pushed tag, never npm publish / dist-tag yourself, never use a token. npm latest stays 1.0.169.
Own temp space only: /private/tmp/cm-v2-wa-${id}. Never edit real host config dirs. Never print credentials. Delete the temp space before you return.
${OWNED}
Rules: every agent gets hooks; never write instruction files; one channel per agent, no fallback paths; native install per host (ADR-0023); no regex as a mechanism; tests first (red before green); never weaken an assertion; never raise a budget; DEVIATIONS.md row per behaviour change. Unit tests need: npm install --no-package-lock, node build/build.mjs --generated-only. node --test tests/v2/ 0 fail before the last push.`

async function retry(prompt, opts, n = 3) {
  for (let i = 0; i < n; i++) {
    const r = await agent(i ? prompt + '\n\nA previous attempt died on an API error. Continue from what is pushed.' : prompt, i ? { ...opts, label: opts.label + '-retry' + i } : opts)
    if (r) return r
    log(`${opts.label}: no result, retry ${i + 1}`)
  }
  return null
}

const AGENTS = ['claude-code', 'codex', 'gemini', 'qwen', 'copilot-cli', 'opencode', 'pi', 'vscode', 'kiro', 'zcode']

phase('Audit')
const audits = (await parallel(AGENTS.map((a) => () => retry(`${base('a-' + a)}\n\nRole: Windows auditor for ${a}. No commits. Read the code paths ${a} uses (src/setup/registry.ts, engine.ts, spawn-bin.ts, src/adapters/table.ts row, build/manifests.ts, hooks/*.json for ${a}, doctor, ctx_upgrade) and the host's docs for Windows (web search; quote URL + version). Check each of these on Windows:
- where the host keeps its config/plugin/extension/skills dirs on Windows (%USERPROFILE%, %APPDATA%, %LOCALAPPDATA%; e.g. Claude Desktop %APPDATA%\\Claude, VS Code %APPDATA%\\Code\\User) vs what we use;
- the registered hook and MCP command: node path with spaces (C:\\Program Files\\nodejs\\node.exe), quoting, backslashes inside JSON/TOML/YAML, env placeholders the host expands on Windows (\${CLAUDE_PLUGIN_ROOT}, \${extensionPath}, \${PLUGIN_ROOT});
- spawning the host CLI: npm .cmd/.ps1 shims, PATHEXT, no shell:true with user input;
- path compare (case, separators, drive letters, UNC, 8.3 short names), CRLF in files we read or write, a UTF-8 BOM;
- file writes: rename over a file another process holds (EBUSY/EPERM), backups and rollback;
- the hook process: stdin read, exit codes, stdout encoding (UTF-8 vs code page), timeouts and the grandchild kill;
- skills dir and native install command on Windows.
Report only real defects with file:line evidence (no guesses; mark "unverified" when you could not prove it). Return agent, findings (id, area, file, problem, evidence, fix), windowsPaths (where the host keeps each file on Windows, with source).`,
  { label: `wa-a-${a}`, phase: 'Audit', schema: AUD, ...SNM })))).filter(Boolean)
const findings = audits.flatMap((x) => x.findings.map((f) => ({ ...f, agent: x.agent })))
log(`findings: ${findings.length}`)

phase('Matrix')
const matrix = await retry(`${base('matrix')}\n\nRole: build the Windows proof. Add a job to .github/workflows/ci.yml (or extend "setup e2e") that runs on windows-latest (and the same script on ubuntu/macos) and, from the packed release-out package installed with npm i -g, for EACH of the 10 agents: installs the host CLI when npm can install it without login (@anthropic-ai/claude-code, @openai/codex, @google/gemini-cli, @qwen-code/qwen-code, @github/copilot, opencode-ai, pi's npm package; check names), runs context-mode setup --yes --agents <a>, context-mode doctor --agents <a>, then pipes the host's documented PreToolUse/BeforeTool payload for a 200 KB shell cat into the registered hook command exactly as written in the host config (so quoting and placeholders are exercised) and asserts the deny/replace output; then runs the MCP server command from the host config and does an initialize + tools/list handshake. Hosts whose CLI cannot be installed (vscode, kiro, zcode) still run setup/doctor/hook/MCP from the written config. Paths: put the npm prefix under a dir with a space in its name. Script under e2e/checks/windows-hosts.mjs, red first is the job itself: push it, let CI run, and report per host and OS pass/fail with log lines (gh run watch). Do not fix product code here; list every failure. Return done, commits, numbers (per host x OS), summary (failures with log lines).`, { label: 'wa-matrix', phase: 'Matrix', schema: RESULT, ...SNH })

phase('Fix')
const groups = {}
for (const f of findings) (groups[f.area] = groups[f.area] || []).push(f)
const groupList = Object.entries(groups)
const fixes = await parallel(groupList.map(([area, fs], i) => () => retry(`${base('f' + i)}\n\nRole: Windows fixer for area "${area}". Findings: ${JSON.stringify(fs).slice(0, 7000)}. Windows CI matrix result: ${JSON.stringify(matrix && matrix.summary || '').slice(0, 3000)}. Fix each real defect at the root, one shared helper per concern (no per-host copies), red test first that runs on every OS (fake Windows paths/env), plus a windows-only test where only a real Windows run proves it. Skip a finding only with evidence it is not a defect; say why. After your last push, watch ci.yml on your head and report the Windows jobs. Return done, commits, numbers, summary.`, { label: `wa-f-${i}`, phase: 'Fix', schema: RESULT, ...SNH })))
const fixMatrix = await retry(`${base('fixm')}\n\nRole: make the Windows host matrix (e2e/checks/windows-hosts.mjs, ci.yml) green on windows-latest, ubuntu and macos. Pull the latest v2-design (other Windows fixes landed). Read the latest ci.yml run on the head; for every remaining host x OS failure fix the root cause (test-first), push, re-watch; max 3 rounds. Never skip a host on Windows to get green; a host the runner cannot exercise must say why in the job log and in docs/v2/release/WINDOWS.md. Write docs/v2/release/WINDOWS.md: per host, Windows paths, native install command on Windows, matrix result, open items. Return done (true only when the matrix is green on all 3 OS), commits, numbers, summary.`, { label: 'wa-fixm', phase: 'Fix', schema: RESULT, ...SNH })

phase('Release')
let rel = null
if (fixMatrix && fixMatrix.done) {
  rel = await retry(`${base('rel')}\n\nRole: release the next prerelease (owner approved npm next releases; owner rule: ship finished work at once). Find N: the highest 2.0.0-next.N in the raw registry JSON and in origin tags, plus 1. Wait until no release.yml run is in progress. Wait for ci.yml on the v2-design head to be green incl. the Windows host matrix (gh run watch, up to 60 min; if red, fix test-first, max 2 rounds; else return published=false). Check latest is 1.0.169 and the tag does not exist. git tag -a v2.0.0-next.N -m v2.0.0-next.N <green head>; push only that tag; watch release.yml (up to 90 min); a single job failing only on a timing budget or known flaky Windows test gets one gh run rerun --failed. Verify against the raw registry: next = the new version, latest 1.0.169, provenance; GitHub prerelease created after npm publish; v1.0.169 still Latest. Update docs/v2/release/NEXT-STATUS.md with the version and the Windows section. Return published, version, failingStep, logLines, summary.`, { label: 'wa-rel', phase: 'Release', schema: REL, ...SNH })
}
return { findings: findings.length, audits, matrix, fixes, fixMatrix, rel }
