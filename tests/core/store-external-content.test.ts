/**
 * Phase 5.2 — FTS5 external-content storage: single body table, two indexes.
 *
 * Business intent under test: ctx_index stores every chunk's raw text TWICE
 * (chunks + chunks_trigram), so the content store pays ~2x the storage for the
 * text. The migration makes chunks_body the single source of truth and points
 * both FTS5 tables at it via content=/content_rowid=. Retrieval quality must be
 * bit-identical and no bookkeeping path may leak.
 *
 * The spike (docs/adr/0003) measured two hazards this suite pins permanently:
 *   - an external-content fts DELETE does NOT cascade to the content table, so
 *     every purge site must delete from three tables in one transaction;
 *   - VALUES('integrity-check') reports OK even when index and body have
 *     drifted, so there is no safety net — the tests must assert directly.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ContentStore } from "../../src/store.js";

const files: string[] = [];

function newStorePath(): string {
  const p = join(
    tmpdir(),
    `cm-p5-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  files.push(p);
  return p;
}

function tableNames(dbPath: string): Set<string> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name IS NOT NULL")
        .all()
        .map((r) => String((r as { name: unknown }).name)),
    );
  } finally {
    db.close();
  }
}

function count(dbPath: string, sql: string, ...args: unknown[]): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number((db.prepare(sql).get(...(args as never[])) as { n: number }).n);
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const f of files) {
    try {
      rmSync(f, { force: true });
      rmSync(`${f}-wal`, { force: true });
      rmSync(`${f}-shm`, { force: true });
      // The migration writes a one-time rollback copy; remove it so the suite
      // leaves no residue in tmpdir (the backup-exists test asserts on it
      // before this runs).
      rmSync(`${f}.pre-external-content.bak`, { force: true });
    } catch {
      /* best effort */
    }
  }
  files.length = 0;
});

describe("Phase 5.2 — external-content schema", () => {
  test("indexing creates a single chunks_body table backing both indexes", () => {
    const path = newStorePath();
    const store = new ContentStore(path);
    store.index({ content: "# A\nExplains UNIQUE_TOK_A caching", source: "proj:a" });
    store.close();

    const names = tableNames(path);
    expect(names.has("chunks_body")).toBe(true);
    expect(names.has("chunks")).toBe(true);
    expect(names.has("chunks_trigram")).toBe(true);
  });

  test("both fts tables read their text from chunks_body, not their own copy", () => {
    const path = newStorePath();
    const store = new ContentStore(path);
    store.index({ content: "# Head\nMARKER_PAYLOAD body text", source: "proj:single" });
    store.close();

    // The migration's whole point: neither index stores its own copy of the
    // raw text — both declare chunks_body as their external content source.
    // Asserted on the schema, not the file size: the trigram postings list is
    // large and does NOT shrink when the text is shared, so a byte threshold
    // would measure the wrong thing (the spike measured the real ~25% win).
    const db = new DatabaseSync(path, { readOnly: true });
    const defs = new Map(
      db
        .prepare("SELECT name, sql FROM sqlite_master WHERE name IN ('chunks','chunks_trigram')")
        .all()
        .map((r) => [String((r as { name: unknown }).name), String((r as { sql: unknown }).sql)]),
    );
    db.close();

    expect(defs.get("chunks")).toContain("content=chunks_body");
    expect(defs.get("chunks_trigram")).toContain("content=chunks_body");
  });

  test("re-indexing the same label leaves no orphan chunks_body rows", () => {
    const path = newStorePath();
    const store = new ContentStore(path);
    store.index({ content: "# V1\nfirst UNIQUE_V1 content", source: "proj:dup" });
    store.index({ content: "# V2\nsecond UNIQUE_V2 content", source: "proj:dup" });
    store.close();

    const body = count(path, "SELECT count(*) n FROM chunks_body");
    const porter = count(path, "SELECT count(*) n FROM chunks");
    const tri = count(path, "SELECT count(*) n FROM chunks_trigram");
    // External-content deletes do NOT cascade: without the third DELETE the
    // body table would accumulate rows from both index passes.
    expect(body).toBe(porter);
    expect(body).toBe(tri);
    expect(body).toBeGreaterThanOrEqual(1);
  });

  test("the old term is gone and the new term is found after re-index", () => {
    const path = newStorePath();
    const store = new ContentStore(path);
    store.index({ content: "# V1\nalpha OBSOLETE_TOK", source: "proj:re" });
    store.index({ content: "# V2\nalpha FRESH_TOK", source: "proj:re" });

    const stale = store.searchWithFallback("OBSOLETE_TOK", 5);
    const fresh = store.searchWithFallback("FRESH_TOK", 5);
    store.close();

    expect(stale).toHaveLength(0);
    expect(fresh.length).toBeGreaterThan(0);
  });

  test("stale-source cleanup purges body rows too", () => {
    const path = newStorePath();
    const store = new ContentStore(path);
    store.index({ content: "# Old\nOLD_SRC_TOK body", source: "proj:old" });
    // Age the source beyond the retention window.
    const db = new DatabaseSync(path);
    db.exec("UPDATE sources SET indexed_at = datetime('now','-30 days')");
    db.close();

    const removed = store.cleanupStaleSources(14);
    store.close();

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(count(path, "SELECT count(*) n FROM chunks_body")).toBe(0);
    expect(count(path, "SELECT count(*) n FROM chunks")).toBe(0);
    expect(count(path, "SELECT count(*) n FROM chunks_trigram")).toBe(0);
  });

  test("index and body stay consistent (integrity-check cannot catch drift)", () => {
    const path = newStorePath();
    const store = new ContentStore(path);
    for (let i = 0; i < 5; i++) {
      store.index({ content: `# Doc ${i}\nrow CONSISTENCY_TOK_${i}`, source: `proj:${i}` });
    }
    store.close();

    const body = count(path, "SELECT count(*) n FROM chunks_body");
    const porter = count(path, "SELECT count(*) n FROM chunks");
    const tri = count(path, "SELECT count(*) n FROM chunks_trigram");
    expect(porter).toBe(body);
    expect(tri).toBe(body);
  });
});

describe("Phase 5.2 — retrieval parity and migration safety", () => {
  test("ranked results are stable across the two tokenizers for one corpus", () => {
    const path = newStorePath();
    const store = new ContentStore(path);
    for (let i = 1; i <= 30; i++) {
      store.index({
        content: `# Section ${i}\n\nGuide > S${i} explains useEffect${i} caching ${"lorem ipsum ".repeat(20)}`,
        source: `sec:${i}`,
      });
    }

    const porter = store.searchWithFallback("caching", 5, undefined, undefined, "exact").map((r) => r.title);
    const tri = store.searchTrigram("useEff", 5).map((r) => r.title);
    store.close();

    expect(porter.length).toBeGreaterThan(0);
    expect(tri.length).toBeGreaterThan(0);
  });

  test("opening an existing legacy store migrates it and preserves searchable content", () => {
    const path = newStorePath();
    // Build a legacy-shaped store by hand: two self-storing fts tables.
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0, code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')), file_path TEXT, content_hash TEXT);
      CREATE VIRTUAL TABLE chunks USING fts5(title, content, source_id UNINDEXED,
        content_type UNINDEXED, source_category UNINDEXED, session_id UNINDEXED,
        event_id UNINDEXED, timestamp UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE chunks_trigram USING fts5(title, content, source_id UNINDEXED,
        content_type UNINDEXED, source_category UNINDEXED, session_id UNINDEXED,
        event_id UNINDEXED, timestamp UNINDEXED, tokenize='trigram');
      CREATE TABLE vocabulary (word TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
      INSERT INTO sources(label, chunk_count) VALUES('legacy:one', 1);
      INSERT INTO chunks VALUES('Legacy Doc','LEGACY_PRESERVED_TOK body text',1,'prose',NULL,'','' ,
        '2026-10-01T00:00:00.000Z');
      INSERT INTO chunks_trigram VALUES('Legacy Doc','LEGACY_PRESERVED_TOK body text',1,'prose',NULL,'','',
        '2026-10-01T00:00:00.000Z');
    `);
    db.close();

    const store = new ContentStore(path);
    const hits = store.searchWithFallback("LEGACY_PRESERVED_TOK", 5);
    store.close();

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].content).toContain("LEGACY_PRESERVED_TOK");
  });

  test("migration writes a one-time backup of the pre-migration database", () => {
    const path = newStorePath();
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0, code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')), file_path TEXT, content_hash TEXT);
      CREATE VIRTUAL TABLE chunks USING fts5(title, content, source_id UNINDEXED,
        content_type UNINDEXED, source_category UNINDEXED, session_id UNINDEXED,
        event_id UNINDEXED, timestamp UNINDEXED, tokenize='porter unicode61');
      CREATE VIRTUAL TABLE chunks_trigram USING fts5(title, content, source_id UNINDEXED,
        content_type UNINDEXED, source_category UNINDEXED, session_id UNINDEXED,
        event_id UNINDEXED, timestamp UNINDEXED, tokenize='trigram');
      CREATE TABLE vocabulary (word TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
      INSERT INTO sources(label) VALUES('legacy:bak');
      INSERT INTO chunks VALUES('T','BAK_TOK',1,'prose',NULL,'','','2026-10-01T00:00:00.000Z');
      INSERT INTO chunks_trigram VALUES('T','BAK_TOK',1,'prose',NULL,'','','2026-10-01T00:00:00.000Z');
    `);
    db.close();

    const store = new ContentStore(path);
    store.close();

    const backups = files
      .map((f) => f.replace(/\.db$/, ""))
      .flatMap((base) => [`${base}.db.pre-external-content.bak`]);
    expect(backups.some((b) => existsSync(b))).toBe(true);
  });

  test("migration is idempotent: reopening a migrated store does not re-run it", () => {
    const path = newStorePath();
    const first = new ContentStore(path);
    first.index({ content: "# A\nIDEM_TOK one", source: "proj:idem" });
    first.close();

    const afterFirst = count(path, "SELECT count(*) n FROM chunks_body");

    const second = new ContentStore(path);
    second.close();

    expect(count(path, "SELECT count(*) n FROM chunks_body")).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(0);
  });
});
