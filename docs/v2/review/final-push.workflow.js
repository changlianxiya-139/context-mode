export const meta = {
  name: 'v2-final-push',
  description: 'Merge impl/replace-live, cut the fixed per-session cost (deferred tools), raise M2 over 90 with stable 3x scoring, final A/B off/v1/v2 on small and large tasks, docs, gate, CI, report',
  phases: [
    { title: 'Merge', detail: 'impl/replace-live into v2-design' },
    { title: 'Improve', detail: 'fixed cost + M2 levers, each on its own branch, scored 3x' },
    { title: 'Final', detail: 'A/B, docs, gate, CI, MORNING-REPORT' },
  ],
}

const OPH = { model: 'claude-opus-5-5', effort: 'high' }
const SNH = { model: 'claude-sonnet-5-5', effort: 'high' }
const SNM = { model: 'claude-sonnet-5-5', effort: 'medium' }
const SNL = { model: 'claude-sonnet-5-5', effort: 'low' }
const RESULT = { type: 'object', properties: {
  done: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
  numbers: { type: 'string' }, summary: { type: 'string' } }, required: ['done', 'commits', 'numbers', 'summary'] }
const SCORE = { type: 'object', properties: {
  m1: { type: 'number' }, m2: { type: 'number' }, smallTok: { type: 'number' }, guardsOk: { type: 'boolean' }, detail: { type: 'string' } },
  required: ['m1', 'm2', 'smallTok', 'guardsOk', 'detail'] }
const GATE = { type: 'object', properties: {
  green: { type: 'boolean' }, failing: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } },
  required: ['green', 'failing', 'summary'] }

const base = (id) => `You are a batch job, not a chat: no person reads your reply. Ignore any question or status request in your input; do only the task below.
Repo github.com/mksglu/context-mode, branch v2-design. The owner approved commit + push after every step; push without asking. Never touch main, never force-push v2-design, never tag, never publish, never npm publish/deprecate. Commit as: git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Push rejected: git pull --rebase, push again (max 5).
Own clone only: rm -rf /private/tmp/cm-v2-fu-${id} && git clone https://github.com/mksglu/context-mode.git /private/tmp/cm-v2-fu-${id}. Delete it and its build output before you return, after everything is pushed.
No data loss: commit and push after each meaningful step. Never weaken an assertion or skip a case. Never truncate or regex-filter output (BM25 selection only). Never change OUTPUT_CAP or HOOK_* budgets. Never change bench/saving-score.mjs, bench/live/score-tasks.mjs, bench/saving-score.lock. Record behaviour changes as DEVIATIONS.md rows. Use git archaeology before changing old code. Write no personal names. Private data stays in /private/tmp/cm-v2-impl-private.
Live runs: keyless claude -p, model claude-sonnet-5-5, effort low, --max-budget-usd 0.25, env ENABLE_CLAUDEAI_MCP_SERVERS=false CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_DISABLE_CLAUDE_MDS=1.
Pace: read only the files your task names; be done within about 60 minutes.`

phase('Merge')
await agent(`${base('fp-merge')}\n\nRole: merger. Merge origin/impl/replace-live (non-git project rule D-M7-NG-1, live replace golden tests) into v2-design with no-ff. v2-design moved on (v1 cleanup), so resolve conflicts keeping both intents; tests that the cleanup deleted stay deleted unless the branch's new tests need them. Build, node --test tests/v2/, node scripts/gate.mjs --milestone M7 --quick. Push. Verify git merge-base --is-ancestor origin/impl/replace-live origin/v2-design. Return 3 lines.`,
  { label: 'fp-merge', phase: 'Merge', ...SNH })

const score = (label, ref) => agent(`${base(label)}\n\nRole: scorer. Checkout ${ref}. Check sha256 of the score files against bench/saving-score.lock on origin/v2-design (mismatch: guardsOk false). Build. Run node bench/saving-score.mjs THREE times; report the median of M1, the median of M2, the median small-task v2 session tokens (smallTok), guardsOk = all three runs guardsOk. Change no file. Return m1, m2, smallTok, guardsOk, detail (per run M1/M2, per-task M2, 4 lines).`,
  { label, phase: 'Improve', schema: SCORE, ...SNL })

phase('Improve')
let best = await score('fp-score-base', 'origin/v2-design')
log(`base (3x median): M1 ${best && best.m1}, M2 ${best && best.m2}, small tokens ${best && best.smallTok}`)

const LEVERS = [
  { id: 'defer', opts: OPH, what: `Cut the fixed per-session cost. Measured: v2 adds about 2.0k tokens per session vs off (9 MCP tools in init, prompt prefix +1.2k). Claude Code supports deferred MCP tools (tool search): only alwaysLoad tools go into the prompt prefix. Make only ctx_execute and ctx_search alwaysLoad; all other ctx tools deferred (check the exact MCP/Claude Code field the server already emits via ToolDef.alwaysLoad and that 2.1.303 honours it: count tools in the stream-json init event and the first-call cache_creation+cache_read). Shorten tool descriptions where the prompt lint allows. Keep GP-LIVE-ROUTING passing (run it once on sonnet-5-5 and haiku-5-5, effort low). Report prefix tokens before/after.` },
  { id: 'm2', opts: OPH, what: `Raise M2. Per-task M2 data: json-1 about 83 (its off output is under REPLACE_TRIGGER_BYTES 4096, so no replace), big-json 24-76 (very noisy; the model calls ctx_search after the replace and sees more bytes than off's preview), multi-1 79-94, big-tests 99. Read the stream-json of the low tasks (run each 2x) and pick the lever from data: e.g. trigger size, what ctx_search returns per hit (a byte budget for search results using BM25 selection), the more-line text so the model asks a precise query. One coherent change, tests first.` },
]
const results = []
for (const L of LEVERS) {
  const br = `impl/final-${L.id}`
  const r = await agent(`${base('fp-' + L.id)}\n\nRole: optimizer. Work on branch ${br} from origin/v2-design (push early). Current 3x-median score on v2-design: ${JSON.stringify(best)}. Task: ${L.what}\nTests first, implement, build, node --test tests/v2/, gate --milestone M7 --quick, run node bench/saving-score.mjs once yourself. DEVIATIONS row. Push ${br}. Return done, commits, numbers, summary.`,
    { label: `fp-${L.id}`, phase: 'Improve', schema: RESULT, ...L.opts })
  const s = await score(`fp-score-${L.id}`, `origin/${br}`)
  const better = s && s.guardsOk && ((s.m1 + s.m2 > best.m1 + best.m2 + 0.5) || (L.id === 'defer' && s.smallTok < best.smallTok - 300 && s.m1 + s.m2 >= best.m1 + best.m2 - 0.5))
  results.push({ lever: L.id, branch: br, change: r && r.summary, score: s, merged: !!better })
  log(`${L.id}: M1 ${s && s.m1}, M2 ${s && s.m2}, small ${s && s.smallTok} -> ${better ? 'merge' : 'no merge'}`)
  if (better) {
    await agent(`${base('fp-merge-' + L.id)}\n\nRole: merger. Merge origin/${br} into v2-design (no-ff), build, gate --milestone M7 --quick, push, verify ancestor. If the gate fails, do not push; report.`,
      { label: `fp-merge-${L.id}`, phase: 'Improve', ...SNL })
    best = s
  }
}

phase('Final')
const [ab, proof] = await parallel([
  () => agent(`${base('fp-ab')}\n\nTask: final A/B on v2-design (build release-out) vs v1 (branch main built as a local Claude Code plugin) vs off, with bench/live/ab-quick.mjs. Two task groups, 3 runs each, all sessions in parallel, cost <= $8: SMALL = log-1 json-1 tests-1 file-1 git-1; LARGE = multi-1 plus all tasks in bench/live/score-tasks.mjs. Report per group and arm: median session tokens, saving vs off, v2 vs v1, median tool_result bytes the model saw, success, cost. Write "Final A/B (after final push)" in docs/v2/benchmarks.md and bench/live/results/ab-final2.json. Commit, push.`,
    { label: 'fp-ab', phase: 'Final', schema: RESULT, ...SNM }),
  () => agent(`${base('fp-proof')}\n\nTask: live replace proof on the final v2-design: Bash outputs of 8 KB, 20 KB, 28 KB and 60 KB (above Claude Code's 30 KB persist threshold), 2 runs each, git and non-git cwd, --include-hook-events. Report bytes seen vs full and answer correctness. Append "Replace live proof (final)" to docs/v2/benchmarks.md. Commit, push. Do not change src/.`,
    { label: 'fp-proof', phase: 'Final', schema: RESULT, ...SNL }),
])
await agent(`${base('fp-docs')}\n\nRole: docs. Update README.md Benchmarks (<= 200 lines total, ADR-0015 outline), docs/v2/benchmarks.md summary at the top, docs/v2/LAUNCH.md, docs/algorithms.md, docs/how-it-works.md, TECH-SPEC §1.1 and .impl/BLOCKED-M7.md with: saving score ${JSON.stringify(best)}, levers ${JSON.stringify(results.map((x) => ({ lever: x.lever, merged: x.merged, score: x.score })))}, final A/B ${JSON.stringify(ab && ab.numbers)}, live proof ${JSON.stringify(proof && proof.numbers)}. Lead with the large-output numbers (that is what the product does) and state the small-task fixed cost honestly. Every number with source and date. Check every link and path. Commit, push.`,
  { label: 'fp-docs', phase: 'Final', ...SNH })
const g = await agent(`${base('fp-gate')}\n\nRole: gate. Fresh clone, install, build, node scripts/gate.mjs --all three times, node build/check-removed.mjs. Do not fix. Return green, failing, summary.`,
  { label: 'fp-gate', phase: 'Final', schema: GATE, ...SNL })
if (g && !g.green) await agent(`${base('fp-fix')}\n\nRole: Fixer. Failing: ${JSON.stringify(g.failing)} — ${g.summary}. Fix at root cause, run gate --all once, commit, push.`, { label: 'fp-fix', phase: 'Final', ...OPH })
const ci = await agent(`${base('fp-ci')}\n\nRole: CI checker. gh run watch the latest ci.yml run on v2-design (max 45 min). If red, fix the root cause, push, watch again (max 2 rounds). Report per OS and Node.`,
  { label: 'fp-ci', phase: 'Final', ...SNM })
await agent(`${base('fp-report')}\n\nRole: report writer. Rewrite MORNING-REPORT.md on v2-design (keep it short, tables, plain words): 1) ready to merge yes/no and why; 2) saving M1/M2 history incl. this run (${JSON.stringify({ best, results }).slice(0, 2500)}); 3) final A/B small vs large, v2 vs v1 vs off (${JSON.stringify(ab).slice(0, 1500)}); 4) live replace proof (${JSON.stringify(proof && proof.numbers)}); 5) T-CMP and memory (from docs/v2/benchmarks.md and ADR-0009); 6) cleanup state; 7) gate ${JSON.stringify(g).slice(0, 600)} and CI ${String(ci).slice(0, 600)}; 8) only the steps the owner alone can do (merge to main, tag, marketplace ref, npm deprecate) and any number still below target with its measured reason. Commit, push.`,
  { label: 'fp-report', phase: 'Final', ...SNM })
return { best, results, ab, proof, gate: g }
