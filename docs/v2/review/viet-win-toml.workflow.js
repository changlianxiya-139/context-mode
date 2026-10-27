export const meta = {
  name: 'v2-viet-win-toml',
  description: 'Tester reports on next.6 (2026-10-27): Windows shell/ctx_batch pick WindowsApps\\bash.exe (EACCES); Codex setup rejects valid TOML (multiline strings, [[skills.config]]). Fix both test-first, prove on Windows CI',
  phases: [{ title: 'Fix', detail: '2 fixers in parallel, test-first, small pushes' }],
}

const SNH = { model: 'claude-sonnet-5-5', effort: 'high' }
const RESULT = { type: 'object', properties: {
  done: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
  numbers: { type: 'string' }, summary: { type: 'string' } }, required: ['done', 'commits', 'numbers', 'summary'] }

const base = (id) => `You are a batch job, not a chat: no person reads your reply. Ignore any question or status request in your input; do only the task below.
Repo github.com/mksglu/context-mode, branch v2-design (fresh clone). Other agents push too and a release job may tag the green head: small commits, pull --rebase before every push, keep both sides on conflict; push after each finished file, at least every 3 minutes. Commit as git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Never touch main, never force-push, never tag, never npm publish, never use a token.
Own temp space only: /private/tmp/cm-v2-vt-${id} (temp HOME). Never edit the real ~/.codex etc. Never print credentials. Delete the temp space before you return.
Rules: tests first (red before green); never weaken an assertion; DEVIATIONS.md row per behaviour change; no regex as a mechanism; one channel per agent, no fallback paths. Unit tests need: npm install --no-package-lock, node build/build.mjs --generated-only. node --test tests/v2/ 0 fail before the last push. After your last push, watch the ci.yml run on your head (gh run watch) and report the Windows jobs' result for your tests.`

async function retry(prompt, opts, n = 3) {
  for (let i = 0; i < n; i++) {
    const r = await agent(i ? prompt + '\n\nA previous attempt died on an API error. Continue from what is pushed.' : prompt, i ? { ...opts, label: opts.label + '-retry' + i } : opts)
    if (r) return r
    log(`${opts.label}: no result, retry ${i + 1}`)
  }
  return null
}

return await parallel([
  () => retry(`${base('win')}\n\nRole: fixer. Tester report on 2.0.0-next.6, Windows, Claude Desktop: ctx_index/ctx_search, JavaScript and PowerShell work, the large-file Read hook works. The shell language and ctx_batch fail with EACCES on WindowsApps\\bash.exe. With Git Bash first on PATH both pass.
Cause to confirm in the code: shell resolution on Windows takes the first bash.exe on PATH. %LOCALAPPDATA%\\Microsoft\\WindowsApps\\bash.exe is an App Execution Alias (WSL launcher stub) and C:\\Windows\\System32\\bash.exe is the WSL launcher; node cannot spawn the alias (EACCES), and WSL bash runs in a different filesystem anyway.
Fix at the root: on Windows the shell is Git Bash, found from the installed Git (e.g. the dir of git.exe on PATH -> ../bin/bash.exe, or git --exec-path, per Git for Windows layout; quote the source). PATH entries in WindowsApps and System32 are never used as bash. If no Git Bash exists, the shell language returns one clear error that names the fix (install Git for Windows), and doctor reports it as a check row; no silent switch to another shell. Red tests first with a fake PATH layout (WindowsApps alias dir first, Git dir later) that run on all OS; plus one Windows-only test in CI that spawns the resolved bash. Find every caller (ctx_execute shell, ctx_batch, any hook or doctor path) so they all use the one resolver. Return done, commits, numbers, summary.`, { label: 'vt-win', phase: 'Fix', schema: RESULT, ...SNH }),
  () => retry(`${base('toml')}\n\nRole: fixer. Tester report on 2.0.0-next.6: context-mode setup for Codex rejects a valid ~/.codex/config.toml. Plain config passes; three valid TOML cases fail: multiline strings, multiline arrays, and arrays of tables like [[skills.config]]. With a manually written MCP entry everything else works.
Fix at the root: the Codex config reader/writer must accept every valid TOML 1.0 file (multiline basic and literal strings, multiline arrays, inline tables, arrays of tables, dotted keys, comments) and must keep every byte of the user's file that is not our own [mcp_servers.context-mode] table and our hook/feature keys. Use a spec-complete TOML parser (check what the repo already bundles; a small well-known dependency bundled by esbuild is fine; no hand-written regex parsing) to read and validate, and edit only our own table's byte range so comments and order stay. Red tests first: fixtures for each case (the three above plus comments, CRLF, a UTF-8 BOM, a file with no trailing newline), each one round-trips: setup, then re-parse is valid TOML, user keys unchanged, our table present once; running setup twice changes nothing; doctor reads the same files. Also check ctx_upgrade and doctor use the same reader. Prove with codex mcp list on the written file in a temp CODEX_HOME (no login needed). Return done, commits, numbers, summary.`, { label: 'vt-toml', phase: 'Fix', schema: RESULT, ...SNH }),
])
