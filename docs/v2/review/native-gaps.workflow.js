export const meta = {
  name: 'v2-native-gaps',
  description: 'Close native-install verify gaps before next.6 is tagged: qwen doctor after native install, vscode stale doc line, GitHub-source install commands checked against the release branch (the only built-files source until v2 is on main)',
  phases: [{ title: 'Fix', detail: '2 fixers in parallel, test-first, small pushes' }],
}

const OPH = { model: 'claude-opus-5-5', effort: 'high' }
const SNH = { model: 'claude-sonnet-5-5', effort: 'high' }
const RESULT = { type: 'object', properties: {
  done: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
  numbers: { type: 'string' }, summary: { type: 'string' } }, required: ['done', 'commits', 'numbers', 'summary'] }

const base = (id) => `You are a batch job, not a chat: no person reads your reply. Ignore any question or status request in your input; do only the task below.
Repo github.com/mksglu/context-mode, branch v2-design (fresh clone). Other agents push to v2-design too and a release job will tag the green head soon: small commits, pull --rebase before every push, keep both sides on conflict. Commit and push after each finished file, at least every 3 minutes. Commit as git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Never touch main, never force-push, never tag, never npm publish, never use a token.
Own temp space only: /private/tmp/cm-v2-ng-${id} (temp HOME, temp prefix). Never edit the real ~/.claude, ~/.qwen etc. Never print credentials or settings files that hold them. Delete the temp space before you return.
Owner main rule: each agent installs with its own native command (ADR-0023). Rules: tests first (red before green); never weaken an assertion; never raise a budget; DEVIATIONS.md row per behaviour change; no regex as a mechanism. node --test tests/v2/ 0 fail before the last push.`

async function retry(prompt, opts, n = 3) {
  for (let i = 0; i < n; i++) {
    const r = await agent(i ? prompt + '\n\nA previous attempt died on an API error (network). Continue from what is pushed.' : prompt, i ? { ...opts, label: opts.label + '-retry' + i } : opts)
    if (r) return r
    log(`${opts.label}: no result, retry ${i + 1}`)
  }
  return null
}

const out = await parallel([
  () => retry(`${base('qwen')}\n\nRole: fixer. After a native "qwen extensions install <package source>" (Qwen Code 0.26.1, install it in the temp prefix), context-mode doctor --agents qwen FAILS with "not set up", because doctor only knows the link that setup writes. Do what D-NI-CODEX-DOCTOR-1 did for codex: setup and doctor detect the native install (qwen extensions list shows context-mode enabled) and then check it and write nothing extra, so hooks never run twice. Same check for gemini (gemini extensions install). Red test first, then fix, then prove live with the CLI in a temp HOME. Also fix the stale line in docs/install/vscode.md "Setup writes no hook file" (setup writes ~/.copilot/hooks/context-mode-vscode.json; read the code to state it exactly). Return done, commits, numbers, summary.`, { label: 'ng-qwen', phase: 'Fix', schema: RESULT, ...OPH }),
  () => retry(`${base('src')}\n\nRole: docs + proof. docs/install/{claude-code,codex,gemini,qwen}.md install from the GitHub repo (mksglu/context-mode). main still holds v1 and has no v2 built files; the release branch holds the v2 build of the last published next (check its package.json version). Until v2 is on main (ADR-0023, tickets/release-on-demand-no-release-branch.md), the v2 testing commands must point at the release branch with each host's documented ref syntax. For each of the 4 hosts: find the documented ref form (claude: owner/repo#ref; codex: owner/repo@ref or --ref; gemini/qwen: --ref), run the exact command in a temp HOME with the host CLI against github.com/mksglu/context-mode release branch (network clone), check MCP/hooks/skills are registered and doctor passes. If a host cannot install from release because a file is missing there, fix the build so the next release writes it (red test first). Then make each page say: "Testing v2 (next): <command with release ref>"; "After v2 is on main: <command without ref>". Run build/check-install-docs.mjs green. Return done, commits, numbers (per host: command, pass/fail), summary.`, { label: 'ng-src', phase: 'Fix', schema: RESULT, ...SNH }),
])
return out
