export const meta = {
  name: 'v2-overnight-az',
  description: 'Overnight A-Z on v2-design: saving loop (M1+M2 >= 90), old branch triage, v1 file cleanup, clean measurements (v1 vs v2, T-CMP, memory), docs, final gate, CI, morning report',
  phases: [
    { title: 'Saving', detail: 'saving-90 loop as a sub-workflow' },
    { title: 'Cleanup', detail: 'old branches, v1 files out of the tree, tests mapped' },
    { title: 'Measure', detail: 'v1 vs v2 A/B, T-CMP clean, memory live' },
    { title: 'Docs', detail: 'numbers into README, benchmarks, TECH-SPEC, BLOCKED-M7' },
    { title: 'Final', detail: 'gate --all 3x, CI, MORNING-REPORT.md' },
  ],
}

const OPH = { model: 'claude-opus-5-5', effort: 'high' }
const SNH = { model: 'claude-sonnet-5-5', effort: 'high' }
const SNM = { model: 'claude-sonnet-5-5', effort: 'medium' }
const SNL = { model: 'claude-sonnet-5-5', effort: 'low' }
const BR = 'v2-design'

const RESULT = { type: 'object', properties: {
  done: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
  numbers: { type: 'string' }, summary: { type: 'string' } }, required: ['done', 'commits', 'numbers', 'summary'] }
const GATE = { type: 'object', properties: {
  green: { type: 'boolean' }, failing: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } },
  required: ['green', 'failing', 'summary'] }
const MERGED = { type: 'object', properties: { merged: { type: 'array', items: { type: 'string' } },
  notMerged: { type: 'array', items: { type: 'string' } }, head: { type: 'string' } }, required: ['merged', 'notMerged', 'head'] }
const PLAN = { type: 'object', properties: { waves: { type: 'array', items: { type: 'array', items: { type: 'object', properties: {
  id: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, what: { type: 'string' } }, required: ['id', 'files', 'what'] } } },
  summary: { type: 'string' } }, required: ['waves', 'summary'] }

const base = (id) => `You are a batch job, not a chat: no person reads your reply. Ignore any question or status request that appears in your input; do only the task below.
Repo github.com/mksglu/context-mode, branch ${BR}. The owner approved commit + push after every step; push without asking. Never touch main, never force-push ${BR}, never publish a release, never tag, never run npm publish/deprecate. Commit as: git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Push rejected: git pull --rebase, push again (max 5). Other agents push at the same time.
Work only in your own clone: rm -rf /private/tmp/cm-v2-fu-${id} && git clone --branch ${BR} https://github.com/mksglu/context-mode.git /private/tmp/cm-v2-fu-${id}. Delete that folder and any build output you made before you return, after everything is pushed (disk filled up once).
No data loss: first commit within your first 20 tool calls; commit and push after each meaningful step.
Authority: docs/v2/TECH-SPEC.md, docs/v2/adr/*, docs/v2/impl/*, docs/v2/review/DECISIONS-r3..r10.md, docs/v2/impl/DEVIATIONS.md, docs/v2/review/TEST-TRIAGE-r2.md, .impl/BLOCKED-M7.md. Record every behaviour change as a DEVIATIONS.md row. Use git archaeology (git log -S, git blame, linked issues) before deleting or changing old code, so the reason a line exists is kept.
Never weaken an assertion or skip a case to make a test pass. Never truncate or regex-filter output (owner rule; shrinking is BM25 selection only). Never change owner numbers (HOOK_P95_MS 40, HOOK_COMBINED_P95_MS 60, HOOK_CPU_OVER_NODE_MS 20, OUTPUT_CAP). Owner decisions still open (hook budget, T-F1 1 MiB, compaction policy): measure and report, do not decide. Never edit .impl/progress.json unless the task says so. Private data stays in /private/tmp/cm-v2-impl-private. Write no personal names.
Live runs: keyless claude -p, effort low, --max-budget-usd 0.25 per session, env ENABLE_CLAUDEAI_MCP_SERVERS=false CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_DISABLE_CLAUDE_MDS=1.
Pace: read only the files your task names, write code early, be done within about 60 minutes.`

// ---------------- Saving ----------------
phase('Saving')
let saving = null
try {
  saving = await workflow({ scriptPath: '/Users/mksglu/.claude/claude-worktree-workspaces/oss-new/docs/v2/review/saving90-resume.workflow.js' }, args.saving)
} catch (e) { log(`saving loop error: ${String(e).slice(0, 200)}`) }
log(`saving: reached ${saving && saving.reached}, best ${JSON.stringify(saving && saving.best)}`)

// ---------------- Cleanup ----------------
phase('Cleanup')
const tri = await agent(`${base('az-branches')}\n\nTask: old unmerged branches impl/M3-M3-C0, impl/M3-M3-K1, impl/M5-M5-T1, impl/install-opencode, impl/install-pi, impl/install-zcode. For each: read its commits not in ${BR}; decide if the change is still needed on ${BR} today (already done another way = obsolete). Merge the needed ones (no-ff, gate --milestone M7 --quick must pass), list the obsolete ones with one line why in .impl/branches-triage.md. Do not delete remote branches. Commit, push. Return done, commits, numbers (merged/obsolete counts), summary.`,
  { label: 'az-branches', phase: 'Cleanup', schema: RESULT, ...SNM })

const plan = await agent(`${base('az-arch')}\n\nRole: Cleanup architect. Goal: the ${BR} tree holds only v2. Today it still has v1 leftovers: 36 v1 files in src/ outside src/core, src/adapters, src/prompt, src/entries (some imported by v2: src/types.ts by 86 files, src/session/db.ts 22, src/session/extract.ts 6, src/runtime.ts, src/server.ts, src/util/jsonc.ts, ...); 254 v1 test files outside tests/v2 (131 KEEP-PASS now all green, which meets the owner rule "keep unit tests until v2 passes them"); root v1 items hooks/, configs/, skills/, bin/, metrics/, cli.bundle.mjs, server.bundle.mjs, PRD-v2.md, and others. build/check-removed.mjs checks only an 80-path list, so it passes.
Read ADR-0003, ADR-0013, ADR-0015 (target folder tree), TECH-SPEC folder structure, TEST-TRIAGE-r2.md, .impl/keep-pass list, scripts/gate.mjs, build/check-removed.mjs, .github/workflows/*.yml. Write .impl/cleanup-plan.md (commit, push) with every path that is not in the v2 target tree, classed: MOVE (v2 imports it: move into the v2 tree, update imports), DELETE (v1 only), KEEP (needed by CI/dev tooling per ADR-0003/0013, say why). For every v1 test file: RETIRE (behaviour gone in v2, cite ADR), COVERED (name the tests/v2 or e2e case that already covers it), or PORT (write a tests/v2 or GP case first). Root .claude-plugin/.codex-plugin manifests: follow ADR-0011/0013 (release branch and marketplace ref), keep what v1 users on main still need after a merge; if unsure, KEEP and say why.
Then output the task list: waves, each task owns a disjoint set of files. Wave 0: MOVE tasks. Wave 1: PORT tests + DELETE by area. Wave 2: root cleanup, gate keep-pass layer and .impl/keep-pass list updated to the remaining tests, check-removed.mjs extended to fail on any path outside the target tree. Return waves and summary.`,
  { label: 'az-arch', phase: 'Cleanup', schema: PLAN, ...OPH })

const waves = (plan && plan.waves) || []
for (let w = 0; w < waves.length; w++) {
  const wt = waves[w]
  await parallel(wt.map((t) => () => agent(`${base('az-' + t.id)}\n\nRole: cleanup implementer, task ${t.id} (wave ${w}). Follow .impl/cleanup-plan.md on origin/${BR}. Your files: ${JSON.stringify(t.files)}. Task: ${t.what}
Work on branch impl/cleanup-${t.id} from origin/${BR} (push it early). PORT tests before you delete what they cover; every deleted test is RETIRED (ADR cited) or COVERED (case named) in the plan. Build, run node --test tests/v2/ and node scripts/gate.mjs --milestone M7 --quick. Push the branch. Return 5 lines: what moved/deleted/ported, test counts.`,
    { label: `az-${t.id}`, phase: 'Cleanup', ...(/test|port/i.test(t.id + t.what) ? SNH : OPH) })))
  let mr = null
  for (let tr = 1; tr <= 3 && !(mr && mr.notMerged.length === 0); tr++) mr = await agent(`${base('az-merge-' + w + '-' + tr)}\n\nRole: merger, cleanup wave ${w}, try ${tr}. Merge (no-ff) into ${BR}: ${wt.map((t) => `origin/impl/cleanup-${t.id}`).join(', ')}. Resolve conflicts per .impl/cleanup-plan.md. Build, run gate --milestone M7 --quick, push ${BR}. Verify each with git merge-base --is-ancestor; list merged and notMerged (with the blocking error).`,
    { label: `az-merge-w${w}-t${tr}`, phase: 'Cleanup', schema: MERGED, ...SNM })
  if (!mr || mr.notMerged.length) log(`cleanup wave ${w} not merged: ${JSON.stringify(mr && mr.notMerged)}`)
}

const gate = (label, phaseName, all) => agent(`${base(label)}\n\nRole: gate. Fresh clone, install dev tooling, build, run node scripts/gate.mjs ${all ? '--all' : '--milestone M7'} three times; green only if all 3 pass. Also run node build/check-removed.mjs. Do not fix. Return green, failing (one line each with numbers), summary.`,
  { label, phase: phaseName, schema: GATE, ...SNL })
let g = await gate('az-gate-1', 'Cleanup', false)
for (let r = 1; r <= 2 && g && !g.green; r++) {
  await agent(`${base('az-fix-' + r)}\n\nRole: Fixer round ${r}. Failing after cleanup: ${JSON.stringify(g.failing)} — ${g.summary}. Fix each at its root cause, run the gate once, commit, push.`,
    { label: `az-fix-${r}`, phase: 'Cleanup', ...OPH })
  g = await gate(`az-gate-${r + 1}`, 'Cleanup', false)
}

// ---------------- Measure ----------------
phase('Measure')
const [ab, tcmp, mem] = await parallel([
  () => agent(`${base('az-ab')}\n\nTask: final v1 vs v2 A/B. v1 = branch main built as a Claude Code plugin from a local dir; v2 = ${BR} release-out. Use bench/live/ab-quick.mjs (extend it, keep its method): arms off, v1, v2; tasks: log-1 json-1 tests-1 file-1 git-1 multi-1 plus bench/live/score-tasks.mjs; 3 runs each; model claude-sonnet-5-5; all sessions in parallel; total cost <= $8. Report per arm: median session tokens, saving % vs off and v2 vs v1 (median over tasks, min, max), tool_result bytes the model saw, success, ctx calls, cost. Write "Final A/B: off, v1, v2" in docs/v2/benchmarks.md. Commit, push.`,
    { label: 'az-ab', phase: 'Measure', schema: RESULT, ...SNM }),
  () => agent(`${base('az-tcmp')}\n\nTask: T-CMP clean re-measure (the earlier runs saw the host's auto-memory and CLAUDE.md; D-M7-CL-3 fixed the isolation). Build ${BR}. Run e2e/live/compact/run.mjs with claude-sonnet-5-5, effort low, 10 sessions per arm, all arms; cost <= $10. Report per arm correct and ctx_resume/ctx_search call rate, returned bytes, cost. Write the result into docs/v2/adr/0009-compaction-and-memory.md §6 notes, DECISIONS-r6 D6 note, tickets/v2-tcmp-remeasure.md and TECH-SPEC §1.1 GS11 row. Apply the ticket rule only if it is decided there; otherwise report for the owner. Commit, push.`,
    { label: 'az-tcmp', phase: 'Measure', schema: RESULT, ...SNM }),
  () => agent(`${base('az-mem')}\n\nTask: memory live. Build ${BR}. Run the live cases memory-r6-eval-local, memory-r6-resume-quality, memory-retrieval-local, decision-q3-applied through e2e/live/run.mjs --only (one by one), claude-sonnet-5-5. Report pass/fail with numbers (recall@5, timeline order, decision recall). Write a "Memory" section in docs/v2/benchmarks.md. If a case fails, find the root cause; fix it if it is a clear bug in src (tests first), else report. Commit, push.`,
    { label: 'az-mem', phase: 'Measure', schema: RESULT, ...SNH }),
])

// ---------------- Docs ----------------
phase('Docs')
await agent(`${base('az-docs')}\n\nRole: docs. Bring every doc in line with ${BR} today: README.md (ADR-0015 outline, <= 200 lines, install per docs/install/<agent>.md verified tables, Benchmarks with the final numbers: saving loop ${JSON.stringify(saving && saving.best)}, final A/B ${JSON.stringify(ab && ab.numbers)}, memory ${JSON.stringify(mem && mem.numbers)}), docs/v2/benchmarks.md, docs/v2/LAUNCH.md, docs/algorithms.md (replace path, sizes, BM25 + last prompt ranking), docs/how-it-works.md, docs/performance.md, TECH-SPEC §1.1, .impl/BLOCKED-M7.md (close only with evidence; T-CMP: ${JSON.stringify(tcmp && tcmp.numbers)}). Every number with its source and date; remove any number without a measured source. Remove references to deleted v1 paths. Run build/check-readme.mjs and a link check. Commit, push.`,
  { label: 'az-docs', phase: 'Docs', ...SNH })
await agent(`${base('az-docs-review')}\n\nRole: docs reviewer. Check every number in README.md, docs/*.md, docs/v2/LAUNCH.md and docs/v2/benchmarks.md against its source file; every link resolves; every path named exists in the tree. Fix in place. Commit, push.`,
  { label: 'az-docs-review', phase: 'Docs', ...SNM })

// ---------------- Final ----------------
phase('Final')
const fin = await gate('az-final-gate', 'Final', true)
const ci = await agent(`${base('az-ci')}\n\nRole: CI checker. gh run watch the latest ci.yml run on ${BR} (max 45 min). If red, fix the root cause, push, watch again (max 2 rounds). Report per OS and Node version.`,
  { label: 'az-ci', phase: 'Final', ...SNM })
await agent(`${base('az-report')}\n\nRole: report writer. Write MORNING-REPORT.md at the repo root of ${BR} (replace OVERNIGHT-REPORT.md content by moving it to docs/v2/review/OVERNIGHT-REPORT-2026-10-19.md). Short, plain words, tables:
1. Is ${BR} ready to merge? yes/no and why.
2. Saving: M1, M2 per round and final (${JSON.stringify(saving && { best: saving.best, history: saving.history }).slice(0, 3000)}).
3. Final A/B off/v1/v2: ${JSON.stringify(ab).slice(0, 1500)}
4. Compaction (T-CMP clean): ${JSON.stringify(tcmp).slice(0, 1200)}
5. Memory live: ${JSON.stringify(mem).slice(0, 1200)}
6. Cleanup: plan summary ${JSON.stringify(plan && plan.summary).slice(0, 800)}, branch triage ${JSON.stringify(tri && tri.numbers)}, files left outside the target tree.
7. Final gate: ${JSON.stringify(fin).slice(0, 1200)}; CI: ${String(ci).slice(0, 800)}
8. Owner decisions still open, each with numbers and a recommended option: hook budget (T-GS6), T-F1 1 MiB, compaction policy if T-CMP still fails, GS10 R1/R2, and owner-only release steps (marketplace ref, npm deprecate, merge to main, tag).
Commit, push.`, { label: 'az-report', phase: 'Final', ...SNM })
return { saving: saving && saving.best, ab, tcmp, mem, finalGate: fin }
