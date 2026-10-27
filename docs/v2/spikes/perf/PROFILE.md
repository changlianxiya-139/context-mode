# Profile: D3 hook overhead and GP-SEARCH held-out p95 (P1, owner rule: never forget profiling)

Limits: D3 hook overhead p95 15 ms (CI windows node 24 read 17 ms); GP-SEARCH held-out ctx_search p95 50 ms
(CI ubuntu node 24 read 67 ms). Budgets are not changed. Goal: 30% headroom on a local 10-run p95.

Method:
- Hook: `node --cpu-prof --cpu-prof-interval 50 release-out/hook.mjs --agent claude-code < PreToolUse Bash payload`,
  3 runs, self time per frame averaged per run. Inclusive time from an unminified build of the same entry.
- Search: the GP-SEARCH-heldout flow (index held-out sources + 1 MB of docs/v2), then a fresh server with
  `NODE_OPTIONS=--cpu-prof --cpu-prof-interval 100` runs the 50 held-out queries 10 times; self time per frame.
- Host: macOS, Node 26.8.1, load average about 13 (shared machine, 14 other agents). Numbers are noisy.

## Before (b5848ef6)

### Hook, PreToolUse cold start, self time per run (ms)

```
total 18.54 ms/run
   9.73 (idle) :-1
   3.32 compileSourceTextModule utils:337
   0.42 (anon) hook.mjs:0
   0.25 read :-1
   0.23 normalizeString node:path:91
   0.23 Nc hook.mjs:185
   0.23 (program) :-1
   0.17 Mi hook.mjs:23
   0.16 getCLIOptionsFromBinding options:31
   0.14 dt hook.mjs:15
   0.13 stat :-1
   0.12 bu hook.mjs:21
```

### Search, 500 ctx_search calls, self time per profile (ms)

```
total 3791.51 ms/run
 909.33 ftsQuery server.mjs:31552
 885.22 porter server.mjs:31556
 353.88 withWrite server.mjs:28926
 249.38 (idle) :-1
 201.90 stmt server.mjs:31500
 176.28 closeDb server.mjs:28937
  92.36 typoTerms server.mjs:31527
  53.83 realpath :-1
  50.00 openReadOnly server.mjs:28892
  40.39 readUserVersion server.mjs:28857
  37.51 find server.mjs:29475
  34.52 (garbage collector) :-1
  34.51 buildSnippet server.mjs:29409
  31.71 compileSourceTextModule utils:337
  30.89 (anon) server.mjs:31565
```

## Root cause and fix (search)

`ftsQuery`/`porter` are the top frames. Inside them, SQL time: the porter statement ran two
`ROW_NUMBER() OVER` sorts over every match for every scope, but only scope `project` reads
`rank_a`/`rank_b` (RRF). Scope `session`/`worktree` (the default, and the GP-SEARCH path) score by `-bm`.
Fix (D-HQ-PERF-1): `porterRankSql(scope)` picks a statement without the window sorts for
session/worktree. Same rows, same order on all 50 held-out queries. Porter SQL per query
(kept held-out DB, min of 5 passes): 3.44 -> 2.20 ms. Without the `full` subquery it would be 1.58 ms,
but `full` is ranking behaviour (D-SEARCH-2) and stays.

## After (e52388ac)

### Search, 500 ctx_search calls, self time per profile (ms), load average 20-30

```
total 3765.74 ms/run
 863.38 ftsQuery server.mjs:31561
 669.60 porter server.mjs:31566   (885.22 before)
 399.88 (idle) :-1
 341.47 withWrite server.mjs:28926
 153.69 stmt server.mjs:31509     (201.90 before)
 150.84 closeDb server.mjs:28937
 104.37 typoTerms server.mjs:31536
```

### Numbers (local, macOS, Node 26.8.1, shared host)

- GP-SEARCH held-out p95, 10 runs of 50 queries, fresh server: worst run 21.5 ms (second pass;
  first pass 32.6-36.8 ms under load average 30). Budget 50 ms; 30% headroom = 35 ms. Budget unchanged.
- D3 hook overhead (`e2e/checks/setup-hook-overhead.mjs`): claude-code 5 ms, codex 11 ms (batch
  medians 11/30/12/12/13 under load 20+). Budget 15 ms; 30% headroom = 10.5 ms. No hook code change in
  this round: the hook profile is 52% idle (stdin wait, process start) and 18% ESM compile of the
  122 KB bundle; the loaded built-in module list equals bare `node -e 0` (0 extra modules, D-CI-PERF-7
  holds). `NODE_COMPILE_CACHE` gave 2-4 ms on wall time but D-CI-PERF-4 already rejected a cache dir
  written by every hook call. Open: the codex number needs a quiet host to confirm headroom.

### D3 hook bundle size experiment (macOS, Node 26.8.1, load average 7-14)

Question: does a smaller hook bundle cut the PreToolUse cold start? Method: esbuild variants of
`src/entries/hook.ts` (same options as build/build.mjs), each run with `--cpu-prof`; scripts were temp only.

| variant | bytes | compileSourceTextModule (cpu-prof, mean of 15) | fresh-process `import()` p50 / p95 (80 runs) |
|---|---|---|---|
| shipped bundle | 122,227 | 3.0-3.6 ms | 5.88 / 8.54 ms |
| PreToolUse code only (store, index, compaction, journal, detached, decision, throttle stubbed) | 81,083 | 2.29 ms | 5.03 / 6.72 ms |
| store/words.ts stubbed | 112,911 | not run | 5.70 / 7.95 ms |
| `pure: ["Object.freeze"]` (drops unused frozen constants) | 114,351 | 3.00 ms | 5.51 / 6.33 ms |

End to end, 5 batches of 10 runs per host with `--cpu-prof` (wall minus bare-node median; `--cpu-prof`
adds its own cost): shipped claude-code 15.3-17.8 ms, codex 15.2-17.0 ms; PreToolUse-only claude-code
14.7-17.2 ms, codex 14.7-16.4 ms. Wall p95 46-54 ms against bare p95 30-32 ms for all variants.

Result: the most a PreToolUse-only bundle can save is about 1.3 ms of compile (34% fewer bytes). On this
host that gain is smaller than the batch-to-batch noise, so the batches do not show it. No hook code
change. Two rules block the change:
- impl/13 §2.2 step 2 "static imports only" (`assertStaticImports` in build/build.mjs) and GP1
  `adapter-bundle-static-imports` (#1201: hook.mjs copied alone must load) forbid a lazy `import()` of a
  sibling chunk.
- A split per event needs one bundle per event and a hook command per event in every host config (setup
  registry, OUT_FILES, manifests, goldens). That is a design decision for the owner, not one fixer item.
Budget unchanged (15 ms). Open: measure the codex number on a quiet host or CI before any split.

### P2 GP-SEARCH held-out re-profile (macOS, Node 26.8.1, load average 16-19, 2026-10-27)

Trigger: run 40496186557 (ubuntu, Node 26) measured held-out p95 50.5 ms against the 50 ms budget; the
rerun and ci.yml passed. Method: the GP-SEARCH flow (scenario part 2 + held-out sources + 1 MB of
docs/v2) on the built `release-out/server.mjs`, 30 passes of the 50 held-out queries under
`node --cpu-prof`; then per-statement timing by wrapping `StatementSync.prototype.all/get` in process,
and an interleaved old/new A/B of `ftsQuery` on the same `context.db` (61 passes, median per query).

Whole loop (30 passes, ms per `ctx_search` call, includes MCP round trip):

| | p50 | p95 median of runs | p95 worst run | recall@5 | MRR@10 |
|---|---|---|---|---|---|
| before (65843cd2) | 4.39 | 12.16 | 25.08 | 0.98 | 0.829 |
| after (d36b505e) | 4.64 | 12.44 | 72.79 (one run, load 19) | 0.98 | 0.829 |

The whole-loop numbers sit inside host noise. The interleaved in-process A/B isolates the change:

| `ftsQuery` only, scope worktree | p50 | p95 | max | "postgress conection" |
|---|---|---|---|---|
| old | 2.24 | 10.58 | 12.28 | 12.28 |
| new | 2.15 | 10.28 | 10.79 | 10.28 |

Top self-time frames (cpu-prof, 30 passes): before `ftsQuery` 2951 ms, `porter` 2149 ms of 9385 ms;
after `ftsQuery` 3242 ms, `porter` 2369 ms, `typoTerms` 188 ms of 10909 ms (busier host). Both frames
are SQL time inside node:sqlite: `porter` holds the porter statement, `ftsQuery` self holds the trigram
statement (`TRI_RANK`) and `PAGE_ROWS`.

Slowest queries, per statement (best of 15):
- "postgress conection" 12.1 ms: 7.5 ms in `chunks_vocab` reads. fts5vocab has no index on
  `length(term)`; every read walks all 5548 porter terms (3.3-4.5 ms) and typo correction read it once
  per misspelled stem. Fixed (D-HQ-PERF-2): one read per pass; each stem filters its own length window.
  Differential: old vs new `ftsQuery` on 61 queries x 3 scopes x 3 source filters = 549 calls, 0 diffs.
- "sort | uniq -c | sort -rn" 10.7 ms: 8.7 ms in the porter statement. The term `"-c"*` is a prefix
  query on `c` and matches 1102 of 1200 chunks; MATCH alone is 1.7 ms, bm25 plus column reads make it
  5.7 ms. Not changed: dropping short prefixes changes results.
- Long natural queries (8-9 ms): about 3 ms porter + 3-5 ms trigram statement.

Not taken (small or not provably the same): reading trigram columns from `chunks_content` instead of the
`chunks` join (1.40 -> 1.19 ms per query); dropping the `sources` join (only needed for a source filter).
Budget unchanged (50 ms). The ubuntu 50.5 ms is one run of a noisy shared runner; local p95 is about 12 ms.
The whole-loop reply text changed on 2 of 50 queries between the two runs because the 1 MB corpus is
read from docs/v2 at run time and docs/v2 changed by `git pull`; the fixed-DB differential shows 0 diffs.
