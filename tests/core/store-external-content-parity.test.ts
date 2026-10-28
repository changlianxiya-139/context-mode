/**
 * Phase 5.4 — retrieval parity is a permanent regression, not a one-off spike.
 *
 * The external-content migration (Phase 5.2) moved the raw chunk text out of the
 * two self-storing FTS5 tables into a single chunks_body table that both indexes
 * point at via content=/content_rowid=. The load-bearing claim is that this is
 * retrieval-NEUTRAL: the same corpus indexed into the old shape and the new shape
 * must produce bit-identical bm25 rankings, so no query loses recall to the
 * storage refactor.
 *
 * The Phase 5.0 spike (docs/adr/0003) proved this once (check C8). This suite
 * pins it permanently against the CURRENT schema, so a future edit to the
 * tokenizer, column set, or bm25 weights that silently shifts ranking fails here
 * rather than shipping a recall regression.
 *
 * Fixture discipline (learned in spike v1): every row carries a unique token
 * (TOK<i>Z) that is not a substring of any other row's token, so a hit count is
 * always interpretable. Queries deliberately include both a unique token and a
 * common term ("caching", present in every row) to exercise tie-breaking, and
 * both tokenizers (porter + trigram) are compared.
 */

import { describe, test, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";

// Per-row unique token TOK<i>Z; a shared "caching" term to force ties. Column
// set mirrors the current schema (7 user columns, no source_category).
const N = 400;
const chunk = (i: number) => ({
  title: `Guide > Section ${i} > Sub ${i % 7}`,
  content:
    `# Section ${i}\n\nExplains TOK${i}Z caching policy ${"lorem ipsum dolor sit amet ".repeat(30)}\n\n` +
    "```js\nconst answ" + i + " = 42;\n```\n",
  sourceId: (i % 20) + 1,
  contentType: i % 3 === 0 ? "code" : "prose",
  sessionId: `sess-${i % 5}`,
  eventId: `ev-${i}`,
  timestamp: "2026-10-28T00:00:00.000Z",
});
const CORPUS = Array.from({ length: N }, (_, k) => chunk(k + 1));

/** OLD shape: two FTS5 tables, each storing the full text itself. */
function buildSelfStoring(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE VIRTUAL TABLE chunks USING fts5(title, content, source_id UNINDEXED,
      content_type UNINDEXED, session_id UNINDEXED, event_id UNINDEXED,
      timestamp UNINDEXED, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE chunks_trigram USING fts5(title, content, source_id UNINDEXED,
      content_type UNINDEXED, session_id UNINDEXED, event_id UNINDEXED,
      timestamp UNINDEXED, tokenize='trigram');`);
  const a = db.prepare("INSERT INTO chunks VALUES (?,?,?,?,?,?,?)");
  const b = db.prepare("INSERT INTO chunks_trigram VALUES (?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (const c of CORPUS) {
    const v = [c.title, c.content, c.sourceId, c.contentType, c.sessionId, c.eventId, c.timestamp];
    a.run(...v);
    b.run(...v);
  }
  db.exec("COMMIT");
  return db;
}

/** NEW shape: one content table + two external-content indexes. */
function buildExternal(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE chunks_body (id INTEGER PRIMARY KEY, title TEXT, content TEXT,
      source_id INTEGER, content_type TEXT, session_id TEXT, event_id TEXT, timestamp TEXT);
    CREATE VIRTUAL TABLE chunks USING fts5(title, content, source_id UNINDEXED,
      content_type UNINDEXED, session_id UNINDEXED, event_id UNINDEXED,
      timestamp UNINDEXED, content=chunks_body, content_rowid=id, tokenize='porter unicode61');
    CREATE VIRTUAL TABLE chunks_trigram USING fts5(title, content, source_id UNINDEXED,
      content_type UNINDEXED, session_id UNINDEXED, event_id UNINDEXED,
      timestamp UNINDEXED, content=chunks_body, content_rowid=id, tokenize='trigram');`);
  const ib = db.prepare("INSERT INTO chunks_body VALUES (?,?,?,?,?,?,?,?)");
  const ip = db.prepare("INSERT INTO chunks(rowid,title,content,source_id,content_type,session_id,event_id,timestamp) VALUES (?,?,?,?,?,?,?,?)");
  const it = db.prepare("INSERT INTO chunks_trigram(rowid,title,content,source_id,content_type,session_id,event_id,timestamp) VALUES (?,?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  CORPUS.forEach((c, k) => {
    const id = k + 1;
    ib.run(id, c.title, c.content, c.sourceId, c.contentType, c.sessionId, c.eventId, c.timestamp);
    ip.run(id, c.title, c.content, c.sourceId, c.contentType, c.sessionId, c.eventId, c.timestamp);
    it.run(id, c.title, c.content, c.sourceId, c.contentType, c.sessionId, c.eventId, c.timestamp);
  });
  db.exec("COMMIT");
  return db;
}

// bm25 with the store's title:content weighting (5.0 : 1.0). Top-5 rowid order.
function ranked(db: DatabaseSync, table: "chunks" | "chunks_trigram", q: string): number[] {
  return db
    .prepare(
      `SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY bm25(${table}, 5.0, 1.0) LIMIT 5`,
    )
    .all(q)
    .map((r) => Number((r as { rowid: number | bigint }).rowid));
}

// "cache" is the stemming probe: the corpus only ever contains "caching", so it
// is recalled iff the porter stemmer is active. This makes the parity check
// sensitive to a tokenizer-config drift that exact-token queries alone would
// hide (a porter-vs-unicode61 difference is invisible to "caching").
const QUERIES = ["TOK42Z", "TOK7Z", "Section", "caching", "cache", "answ13", "lorem ipsum dolor"];

describe("Phase 5.4 — external-content retrieval parity (permanent)", () => {
  test("fixture is discriminating: every query is recalled by at least one index", () => {
    // Guards against a false-green parity check: if a query matched nothing in
    // either shape, "identical rankings" would be vacuous. A query need not hit
    // BOTH indexes — "cache" is a porter-only stemming probe (the trigram index
    // legitimately misses it, since "caching" has no "che" trigram).
    const ext = buildExternal();
    try {
      for (const q of QUERIES) {
        const porter = ranked(ext, "chunks", q).length;
        const trigram = ranked(ext, "chunks_trigram", q).length;
        expect(porter + trigram, `'${q}' recalled by neither index`).toBeGreaterThan(0);
      }
      // The stemming probe MUST be recalled by the porter index specifically —
      // this is what gives the parity check sensitivity to tokenizer drift.
      expect(ranked(ext, "chunks", "cache").length, "porter 'cache' empty").toBeGreaterThan(0);
    } finally {
      ext.close();
    }
  });

  test("self-storing and external-content produce bit-identical bm25 top-5 for both tokenizers", () => {
    const ext = buildExternal();
    const cur = buildSelfStoring();
    const mismatches: string[] = [];
    try {
      for (const q of QUERIES) {
        for (const table of ["chunks", "chunks_trigram"] as const) {
          const a = ranked(ext, table, q);
          const b = ranked(cur, table, q);
          if (JSON.stringify(a) !== JSON.stringify(b)) {
            mismatches.push(`${table} '${q}': external=${JSON.stringify(a)} self-storing=${JSON.stringify(b)}`);
          }
        }
      }
    } finally {
      ext.close();
      cur.close();
    }
    expect(mismatches, mismatches.join(" | ")).toEqual([]);
  });
});
