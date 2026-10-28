# ADR 0003 — FTS5 external-content refactor: feasible, benefit smaller than claimed

- **Status**: Accepted (spike passed 9/9) — implementation pending user go/no-go on the revised benefit
- **Date**: 2026-10-28
- **Spec**: `docs/specs/2026-10-27-context-mode-full-takeover.md` §4.3, Phase 5
- **Evidence**: `.planning/2026-10-27-context-mode-gap-closure/spike/fts-external-content-{capability,cost,join}.mjs`
- **Supersedes the premise of**: spec §4.3 as written (its "~2x write amplification" framing is corrected below)

## Context

`ctx_index` writes every chunk twice — into `chunks` (porter unicode61) and
`chunks_trigram` (trigram) — each storing the full raw text
(`src/store.ts:475-497`, double insert at `:1065-1066`). The README describes
"a SQLite FTS5 virtual table" (singular), so the duplication is invisible to
users. The spec proposed collapsing to one content table with two
external-content indexes (`content=` / `content_rowid=`), and the user ruled it
mandatory.

The spec justified it as removing "~2x disk and write amplification". That
number was an assumption, not a measurement. This spike measures it.

## Feasibility — verified, no blocker

Environment: node:sqlite 3.53.1 (this host's path), better-sqlite3 3.53.0 (other
platforms). trigram needs >= 3.34, so both are fine.

| Check | Result |
|---|---|
| C1 trigram tokenizer accepts `content=` external table | PASS |
| C2 porter `MATCH` + `bm25(chunks, 5.0, 1.0)` + `highlight()` | PASS |
| C3 trigram substring semantics preserved | PASS — 111-row `TOK1` family, byte-identical row order to the current schema |
| C4 UNINDEXED columns retrievable through the fts table | PASS |
| C5 the store's real purge shape `DELETE FROM <fts> WHERE source_id IN (SELECT ...)` | PASS on **both** tokenizers |
| C5b content rows cascade-delete with the index | **FAIL — by design** (see Consequences) |
| C6 re-index cycle (delete then re-insert same rowid) | PASS — no ghost term, new content found |
| C8 ranked top-5 parity, 6 queries x 2 tokenizers | PASS — 12/12 lists identical |
| C7 disk | PASS — see below |
| JOIN `sources ON sources.id = chunks.source_id` (store.ts:585-599) | PASS — content readable, highlight works, source-scoped filter works, purge works |

No `UPDATE` statement targets `chunks` anywhere in the store, so the awkward
external-content UPDATE semantics never apply.

## Measured benefit — ~25% disk, not 50%; writes slightly faster

4000 realistic chunks (~4 KB each, headings + fenced code):

| Schema | Insert (single transaction) | Database file |
|---|---|---|
| current (two full-text fts tables) | 278.8 ms | 14.93 MB |
| external-content (one body + two indexes) | 257.3 ms | 11.24 MB |

**Disk −24.7%** (26.7% at 400 chunks — consistent). **Write −8% latency** despite
one extra statement per row.

Correction to the spec's premise: the duplicated raw text is only part of the
cost. Both inverted indexes still store their own full postings lists — the
trigram index is in fact the larger of the two — so sharing the text cannot
halve anything. "~2x write amplification" was wrong; the honest figure is
roughly a quarter of storage, with write throughput neutral-to-better.

## Decision

Proceed only if a ~25% content-store reduction is worth an irreversible schema
migration. The original motivation (2x) is gone. The capability risk is low —
every operation the store performs was verified — but the payoff is a quarter,
not half.

## Consequences

1. **Deletes must cover three tables.** An external-content fts `DELETE` removes
   index entries but NOT the content row (C5b). Both purge sites
   (`store.ts:575/578` by label, `:814/817` stale-source sweep) gain a third
   `DELETE FROM chunks_body ...`, inside the existing transaction.
2. **No safety net for drift.** `INSERT INTO <fts>(<fts>) VALUES('integrity-check')`
   reported OK even after a content row was deleted without its index entry —
   drift is silent. The three-table delete must be transactional; a partial
   failure would leave rows that match but have no body (or vice versa).
3. **Insert path gains one statement** (3 vs 2). Measured net effect is still
   faster.
4. **Migration is irreversible** → ship with the existing DROP-and-rebuild
   precedent (`store.ts:518-545`), a pre-migration file copy, an idempotency
   guard (run twice = same result), and a documented rollback (restore the copy).
   Content stores are rebuildable from source files for file-backed sources, but
   session-event chunks are not, so the backup is load-bearing.
5. **README stays corrected** either way: the docs must stop describing one
   virtual table when the schema has two (already done in `e4f0bf4`).
6. **All three tables must share every rowid.** An external-content fts
   `DELETE` resolves the old column values by rowid against the content table
   (`chunks_body`) before removing postings. If a body row exists but the
   matching index entry is missing, that lookup hits an inconsistent shadow
   state and SQLite aborts the whole `DELETE` with `database disk image is
   malformed` — observed on the `trigram` index specifically, and only when the
   body/index rowid sets diverge (a `porter` index over the same rows deletes
   cleanly). `ContentStore.#insertChunks` writes body + both indexes at one
   rowid, so production never diverges; the trap only surfaces in tests that
   seed the indexes independently (`purge-session.test.ts` previously inserted a
   chunk into the body + porter index while skipping trigram). Rule: any raw
   seed of an external-content store MUST insert every row into BOTH indexes.

## Rollback

`git revert` the Phase 5 commit, then restore the pre-migration `.db` copy. The
new schema is not readable by the old code (the fts tables lose their stored
text), so the backup is required, not optional.
