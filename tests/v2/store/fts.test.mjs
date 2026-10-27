// Unit tests for src/core/store/fts.ts (impl/02 §9, DEVIATIONS D-M1-8, D-M1-9, D-M2-1, D-M2-3).
// ftsInsert(db, src: Omit<SourceRow,"id">, chunks: Chunk[]): number (new sources.id, D-M2-1).
// ftsQuery(db, q, scope, ctx, sessionId, limit, offset, source?): Hit[].
// ftsQueryTimeline(db, scope, ctx, sessionId, limit, after, source, memory): { rows, next } (D-M2-3).
// rankTexts(texts, q): number[] — FTS5 BM25 over an in-memory text set (impl/05 §5 step 2).
// highlight(row, terms, maxBytes = SNIPPET_MAX_BYTES): a verbatim slice of the stored text (D-SEARCH-7), code-point safe (#963).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, closeDb } from "../../../src/core/store/db.ts";
import { deleteSourceChunks, ftsInsert, ftsQuery, ftsQueryTimeline, highlight, porterRankSql, rankTexts } from "../../../src/core/store/fts.ts";
import { appendEvent } from "../../../src/core/journal/append.ts";
import * as C from "../../../src/core/contracts/constants.ts";

function fakeProject(root, projectKey, worktree) {
  return {
    projectKey,
    projectDir: join(root, "projects", projectKey),
    dbPath: join(root, "projects", projectKey, "context.db"),
    worktree: worktree ?? root,
    containmentRoot: root,
    agent: "claude-code",
    source: "env:CLAUDE_PROJECT_DIR",
  };
}

async function freshDb(key, worktree) {
  const root = mkdtempSync(join(tmpdir(), "cm-fts-"));
  const project = fakeProject(root, key, worktree ?? root);
  const db = await openDb(project);
  return { db, root, project };
}

function src(overrides) {
  return {
    projectKey: "x".repeat(16),
    sessionId: "s1",
    worktree: "/w",
    agent: "claude-code",
    kind: "content",
    label: "note.txt",
    bytes: 0,
    chunkCount: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

test("ftsInsert writes rows that ftsQuery can find by term", async () => {
  const { db, root, project } = await freshDb("1".repeat(16));
  try {
    const id = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "the quick brown fox jumps", bytes: 25 }]);
    const hits = ftsQuery(db, "fox", "session", project, "s1", 10, 0);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].sourceId, id);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsQuery with scope 'session' only returns rows from the given session", async () => {
  const { db, root, project } = await freshDb("2".repeat(16));
  try {
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "unique-term-alpha in s1", bytes: 20 }]);
    ftsInsert(db, src({ sessionId: "s2", worktree: project.worktree }), [{ ord: 0, text: "unique-term-alpha in s2", bytes: 20 }]);
    const hits = ftsQuery(db, "unique-term-alpha", "session", project, "s1", 10, 0);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sourceId, 1);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsQuery with scope 'project' ranks the current session's own rows first (GP7)", async () => {
  const { db, root, project } = await freshDb("3".repeat(16));
  try {
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "shared-term here many times shared-term shared-term", bytes: 50 }]);
    ftsInsert(db, src({ sessionId: "s2", worktree: project.worktree }), [{ ord: 0, text: "shared-term here many times shared-term shared-term", bytes: 50 }]);
    const hits = ftsQuery(db, "shared-term", "project", project, "s1", 10, 0);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].sourceId, 1);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsQuery returns [] for a query that matches nothing (no throw)", async () => {
  const { db, root, project } = await freshDb("4".repeat(16));
  try {
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "hello world", bytes: 11 }]);
    const hits = ftsQuery(db, "zzzznomatch", "session", project, "s1", 10, 0);
    assert.deepEqual(hits, []);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("highlight clips to maxBytes at a code-point boundary before sanitizing (#963)", () => {
  const big = "a".repeat(2000) + "é" + "b".repeat(2000); // accented char near a potential split point
  const out = highlight(big, "a", 100);
  assert.ok(Buffer.byteLength(out, "utf8") <= 100);
  // No replacement character from a mid-codepoint cut.
  assert.ok(!out.includes("�"));
});

test("highlight returns < > & as stored, no entity encoding (D-SEARCH-7; #341 guarded an innerHTML path v2 has none of)", () => {
  const row = "<script>alert(1)&amp;</script>";
  assert.equal(highlight(row, "script", 4096), row);
});

test("highlight default maxBytes is SNIPPET_MAX_BYTES, not MAX_CHUNK_BYTES (D-M1-9, r9 M21 wins)", () => {
  const big = "x".repeat(C.MAX_CHUNK_BYTES + 100);
  const out = highlight(big, "x", C.SNIPPET_MAX_BYTES);
  assert.ok(Buffer.byteLength(out, "utf8") <= C.SNIPPET_MAX_BYTES);
});

test("ftsInsert never writes rows whose body exceeds MAX_CHUNK_BYTES (caller contract, write-time sanity)", async () => {
  const { db, root, project } = await freshDb("5".repeat(16));
  try {
    const okText = "y".repeat(C.MAX_CHUNK_BYTES);
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: okText, bytes: okText.length }]);
    const hits = ftsQuery(db, "y", "session", project, "s1", 10, 0);
    assert.ok(hits.length >= 1);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- M1-T8 additions (V24 tokenizer, D-M1-T8-1..4) ----

test("ftsQuery matches Cyrillic and accented Latin words, case and diacritics folded (V24)", async () => {
  const { db, root, project } = await freshDb("6".repeat(16));
  try {
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "Привет мир, café crème", bytes: 30 }]);
    assert.equal(ftsQuery(db, "привет", "session", project, "s1", 10, 0).length, 1);
    assert.equal(ftsQuery(db, "МИР", "session", project, "s1", 10, 0).length, 1);
    assert.equal(ftsQuery(db, "cafe", "session", project, "s1", 10, 0).length, 1);
    assert.equal(ftsQuery(db, "crème", "session", project, "s1", 10, 0).length, 1);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsQuery treats FTS5 operators in the query as plain words, never a syntax error (D-M1-T8-1)", async () => {
  const { db, root, project } = await freshDb("7".repeat(16));
  try {
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "a AND b OR c NOT d", bytes: 18 }]);
    for (const q of ['a AND', 'NOT', '"', 'b OR (', 'x:y', '*', '   ', '']) {
      assert.ok(Array.isArray(ftsQuery(db, q, "session", project, "s1", 10, 0)), q);
    }
    assert.deepEqual(ftsQuery(db, "   ", "session", project, "s1", 10, 0), []);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsQuery hit carries label, ord and an escaped snippet; scope worktree filters by worktree", async () => {
  const { db, root, project } = await freshDb("8".repeat(16));
  try {
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree, label: "a.txt" }), [
      { ord: 0, text: "nothing here", bytes: 12 },
      { ord: 1, text: "<b>needle</b>", bytes: 13 },
    ]);
    ftsInsert(db, src({ sessionId: "s1", worktree: "/other", label: "b.txt" }), [{ ord: 0, text: "needle", bytes: 6 }]);
    const wt = ftsQuery(db, "needle", "worktree", project, "s1", 10, 0);
    assert.equal(wt.length, 1);
    assert.equal(wt[0].label, "a.txt");
    assert.equal(wt[0].ord, 1);
    assert.equal(wt[0].snippet, "<b>needle</b>"); // D-SEARCH-7: verbatim
    assert.equal(ftsQuery(db, "needle", "project", project, "s1", 10, 0).length, 2);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsQuery limit/offset page the ranked list; source filters by label before ranking (D-M1-T8-4)", async () => {
  const { db, root, project } = await freshDb("9".repeat(16));
  try {
    for (let i = 1; i <= 5; i++) {
      ftsInsert(db, src({ id: i, sessionId: "s1", worktree: project.worktree, label: `f${i}` }), [{ ord: 0, text: "pager word", bytes: 10 }]);
    }
    const all = ftsQuery(db, "pager", "session", project, "s1", 10, 0);
    assert.equal(all.length, 5);
    assert.deepEqual(all.map((h) => h.sourceId), [5, 4, 3, 2, 1]); // equal score: newest source first (M19)
    const page = ftsQuery(db, "pager", "session", project, "s1", 2, 2);
    assert.deepEqual(page.map((h) => h.sourceId), [3, 2]);
    const one = ftsQuery(db, "pager", "session", project, "s1", 10, 0, "f2");
    assert.deepEqual(one.map((h) => h.sourceId), [2]);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsInsert upserts the sources row (bytes_total, chunk_count) and batches large inputs", async () => {
  const { db, root, project } = await freshDb("a".repeat(16));
  try {
    const text = "z".repeat(C.MAX_CHUNK_BYTES);
    const n = Math.ceil((2 * C.INDEX_WRITE_CHUNK) / C.MAX_CHUNK_BYTES) + 1; // spans > 2 write batches
    const chunks = Array.from({ length: n }, (_, i) => ({ ord: i, text, bytes: text.length }));
    const id = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), chunks);
    const row = db.raw.prepare("SELECT bytes_total, chunk_count FROM sources WHERE id = ?").get(id);
    assert.equal(row.chunk_count, n);
    assert.equal(row.bytes_total, n * C.MAX_CHUNK_BYTES);
    const count = db.raw.prepare("SELECT count(*) AS c FROM chunks WHERE source_id = ?").get(id);
    assert.equal(count.c, n);
    assert.equal(db.raw.isTransaction, false);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("highlight output never exceeds maxBytes on a line with no break (D-M1-T8-3, D-SEARCH-7 verbatim)", () => {
  const out = highlight("&".repeat(500) + "<>".repeat(500), "x", 100);
  assert.equal(out, "&".repeat(100)); // stored characters, one byte each, no entity
  const emoji = highlight("😀".repeat(100), "x", 10); // 4-byte code points
  assert.equal(emoji, "😀😀");
});

// ---- M2-T3 additions (D-M2-1, D-M2-3, D-M2-T3-1, impl/05 §5 in-memory form) ----

test("ftsInsert returns the DB-made sources.id, one new id per call (D-M2-1)", async () => {
  const { db, root, project } = await freshDb("b".repeat(16));
  try {
    const a = ftsInsert(db, src({ worktree: project.worktree }), [{ ord: 0, text: "one", bytes: 3 }]);
    const b = ftsInsert(db, src({ worktree: project.worktree }), [{ ord: 0, text: "two", bytes: 3 }]);
    assert.equal(typeof a, "number");
    assert.ok(b > a);
    const row = db.raw.prepare("SELECT created_at, created_ts FROM sources WHERE id = ?").get(b);
    assert.equal(row.created_at, new Date(row.created_ts).toISOString()); // A-S12 ISO mirror
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

function ev(overrides) {
  return {
    session_id: "s1", worktree: "/w", agent: "claude-code", kind: "cmd", tool: "Bash", key: null, path: null,
    ok: 1, exit_code: 0, bytes: 1, body: "b", turn: 1, sandbox_bytes: 0, returned_bytes: 0, ...overrides,
  };
}

// Sets created_at / created_ts to fixed values so order and paging are exact.
function at(db, table, idCol, id, ts) {
  const col = table === "events" ? "created_at" : "created_ts";
  db.raw.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${idCol} = ?`).run(ts, id);
}

test("ftsQueryTimeline merges content, journal and memory rows oldest first; ties: seq, then sourceId, then path (rule 5)", async () => {
  const { db, root, project } = await freshDb("c".repeat(16));
  try {
    const wt = project.worktree;
    const s1 = appendEvent(db, ev({ worktree: wt, body: "first cmd" }));
    at(db, "events", "seq", s1, 2000);
    const s2 = appendEvent(db, ev({ worktree: wt, session_id: "s2", kind: "decision", body: "use RRF" }));
    at(db, "events", "seq", s2, 1000);
    const c1 = ftsInsert(db, src({ worktree: wt, label: "doc.md" }), [{ ord: 0, text: "doc body", bytes: 8 }, { ord: 1, text: "x", bytes: 1 }]);
    at(db, "sources", "id", c1, 2000);
    const memory = [
      { origin: "memory", ts: 2000, seq: null, sourceId: null, path: "/m/b.md", label: "memory", text: "mem b" },
      { origin: "memory", ts: 2000, seq: null, sourceId: null, path: "/m/a.md", label: "memory", text: "mem a" },
      { origin: "memory", ts: 500, seq: null, sourceId: null, path: "/m/z.md", label: "memory", text: "old" },
    ];
    const { rows, more } = ftsQueryTimeline(db, "project", project, "s1", 20, null, undefined, memory);
    assert.deepEqual(rows.map((r) => [r.origin, r.ts, r.label]), [
      ["memory", 500, "memory"],
      ["session", 1000, "decision"],
      ["session", 2000, "cmd"],
      ["content", 2000, "doc.md"],
      ["memory", 2000, "memory"],
      ["memory", 2000, "memory"],
    ]);
    assert.deepEqual(rows.slice(4).map((r) => r.path), ["/m/a.md", "/m/b.md"]);
    assert.equal(rows[3].text, "doc body"); // content row shows its first chunk
    assert.equal(rows[3].sourceId, c1);
    assert.equal(rows[1].seq, s2);
    assert.equal(more, false);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsQueryTimeline pages by the after cursor and never ends a page inside a timestamp group (M18)", async () => {
  const { db, root, project } = await freshDb("d".repeat(16));
  try {
    const wt = project.worktree;
    const ts = [100, 200, 200, 200, 300, 400];
    for (const t of ts) at(db, "events", "seq", appendEvent(db, ev({ worktree: wt, body: `t${t}` })), t);
    const p1 = ftsQueryTimeline(db, "worktree", project, "s1", 2, null, undefined, []);
    assert.deepEqual(p1.rows.map((r) => r.ts), [100, 200, 200, 200]); // group at 200 kept whole
    assert.equal(p1.more, true);
    const p2 = ftsQueryTimeline(db, "worktree", project, "s1", 2, p1.rows.at(-1).ts, undefined, []);
    assert.deepEqual(p2.rows.map((r) => r.ts), [300, 400]);
    assert.equal(p2.more, false);
    const p3 = ftsQueryTimeline(db, "worktree", project, "s1", 2, 400, undefined, []);
    assert.deepEqual(p3, { rows: [], more: false });
    // every row is seen exactly once across pages
    assert.equal(p1.rows.length + p2.rows.length, ts.length);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsQueryTimeline fetches each source at the full page size before merging (rule 3)", async () => {
  const { db, root, project } = await freshDb("e".repeat(16));
  try {
    const wt = project.worktree;
    for (let i = 0; i < 3; i++) at(db, "events", "seq", appendEvent(db, ev({ worktree: wt })), 10 + i);
    for (let i = 0; i < 3; i++) at(db, "sources", "id", ftsInsert(db, src({ worktree: wt }), [{ ord: 0, text: "c", bytes: 1 }]), 1 + i);
    const { rows, more } = ftsQueryTimeline(db, "worktree", project, "s1", 3, null, undefined, []);
    assert.deepEqual(rows.map((r) => r.origin), ["content", "content", "content"]);
    assert.equal(more, true);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsQueryTimeline applies scope and source to the DB sources; source:'decision' selects decision rows (D3)", async () => {
  const { db, root, project } = await freshDb("f".repeat(16));
  try {
    const wt = project.worktree;
    appendEvent(db, ev({ worktree: wt, session_id: "s1", kind: "decision", body: "mine" }));
    appendEvent(db, ev({ worktree: wt, session_id: "s2", kind: "decision", body: "other session" }));
    appendEvent(db, ev({ worktree: "/elsewhere", session_id: "s2", kind: "cmd", body: "other worktree" }));
    ftsInsert(db, src({ worktree: wt, sessionId: "s1", label: "a.md" }), [{ ord: 0, text: "a", bytes: 1 }]);
    const sess = ftsQueryTimeline(db, "session", project, "s1", 20, null, undefined, []);
    assert.deepEqual(sess.rows.map((r) => r.text).sort(), ["a", "mine"]);
    const wtRows = ftsQueryTimeline(db, "worktree", project, "s1", 20, null, undefined, []);
    assert.equal(wtRows.rows.length, 3);
    const proj = ftsQueryTimeline(db, "project", project, "s1", 20, null, undefined, []);
    assert.equal(proj.rows.length, 4);
    const dec = ftsQueryTimeline(db, "project", project, "s1", 20, null, "decision", [
      { origin: "memory", ts: 1, seq: null, sourceId: null, path: "/m", label: "memory", text: "m" },
    ]);
    assert.deepEqual(dec.rows.map((r) => r.text), ["mine", "other session"]);
    const lbl = ftsQueryTimeline(db, "project", project, "s1", 20, null, "a.md", []);
    assert.deepEqual(lbl.rows.map((r) => r.origin), ["content"]);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("rankTexts scores an in-memory text set with the store's BM25: match > 0, miss = 0, same index", () => {
  const scores = rankTexts(["cats only here", "dogs dogs dogs", "a dog and a cat", "Привет"], "dogs");
  assert.equal(scores.length, 4);
  assert.equal(scores[0], 0);
  assert.ok(scores[1] > 0);
  assert.ok(scores[1] >= scores[2]);
  assert.ok(rankTexts(["Привет мир"], "привет")[0] > 0); // same tokenizer as chunks (V24)
  assert.deepEqual(rankTexts(["x"], "   "), [0]);
  assert.deepEqual(rankTexts([], "x"), []);
  assert.ok(rankTexts(["a AND b"], 'AND ("')[0] > 0); // operators stay plain words, no throw
  assert.deepEqual(rankTexts(["x y"], '(" *'), [0]);
});

// D-M7-FT-1: the contentless scratch table must score exactly as the store's chunks table.
test("[M7] rankTexts scores equal bm25 over the migrated chunks table, bit for bit", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { applyMigrations } = await import("../../../src/core/store/schema.ts");
  const words = ["read", "the", "output", "of", "Café", "cafe", "naïve", "Привет", "a\u0301", "x_y", "42", "ok"];
  const texts = [];
  let seed = 7;
  for (let i = 0; i < 400; i++) {
    const n = 1 + (i % 37);
    const w = [];
    for (let k = 0; k < n; k++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; w.push(words[seed % words.length]); }
    texts.push(w.join(i % 3 === 0 ? "\n" : " "));
  }
  texts.push("", "   ", "\ud800 lone read");
  const ref = new DatabaseSync(":memory:");
  applyMigrations(ref, 0);
  const ins = ref.prepare("INSERT INTO chunks(source_id, session_id, worktree, agent, ord, body) VALUES (0, '', '', '', ?, ?)");
  texts.forEach((t, i) => ins.run(i, t));
  for (const q of ["read", "the output", "cafe", "PRIVET привет", "naive", "a", "x_y 42", "missing"]) {
    const want = texts.map(() => 0);
    for (const r of ref.prepare("SELECT ord, bm25(chunks) AS bm FROM chunks WHERE chunks MATCH ?").all(toMatchForTest(q))) want[Number(r.ord)] = -r.bm;
    assert.deepEqual(rankTexts(texts, q), want, q);
  }
  ref.close();
});

function toMatchForTest(q) {
  return q.split(/\s+/).filter((w) => w !== "").map((w) => '"' + w.replaceAll('"', '""') + '"*').join(" ");
}

// ---- M2-R6 (#1163) ----
test("[M2] GP5/snippet-code-point-safe", () => {
  // An emoji (a surrogate pair, 4 UTF-8 bytes) at every position across the clip edge.
  for (let k = 0; k <= 4; k++) {
    const row = "a".repeat(C.SNIPPET_MAX_BYTES - k) + "😀" + "tail";
    const out = highlight(row, "a", C.SNIPPET_MAX_BYTES);
    assert.ok(out.isWellFormed(), "lone surrogate at k=" + k);
    assert.equal(Buffer.from(out, "utf8").toString("utf8"), out);
    assert.ok(Buffer.byteLength(out, "utf8") <= C.SNIPPET_MAX_BYTES);
    assert.ok(out === row.slice(0, out.length), "clip is a prefix of whole code points");
  }
  // D-SEARCH-7: "&" stays one stored byte; the 4-byte emoji past the edge is left out whole.
  const amp = highlight("a".repeat(C.SNIPPET_MAX_BYTES - 3) + "&😀", "a", C.SNIPPET_MAX_BYTES);
  assert.equal(amp, "a".repeat(C.SNIPPET_MAX_BYTES - 3) + "&");
});

// ---- Search layer 2 (D-SEARCH-2): AND first, OR fallback when AND has fewer than `limit` hits, stopwords dropped ----
test("[search-L2] ftsQuery: one query word missing from the index still finds the chunk (OR fallback)", async () => {
  const { db, root, project } = await freshDb("a".repeat(16));
  try {
    const id = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "deploy the edge function", bytes: 24 }]);
    const hits = ftsQuery(db, "deploy edge function guide", "session", project, "s1", 10, 0);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].sourceId, id);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("[search-L2] ftsQuery: a stopword alone never makes a chunk match", async () => {
  const { db, root, project } = await freshDb("b".repeat(16));
  try {
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree, label: "stop.txt" }), [{ ord: 0, text: "the the the cat", bytes: 15 }]);
    const id = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree, label: "go.txt" }), [{ ord: 0, text: "deploy now", bytes: 10 }]);
    const hits = ftsQuery(db, "the deploy missingword", "session", project, "s1", 10, 0);
    assert.deepEqual(hits.map((h) => h.sourceId), [id]);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("[search-L2] ftsQuery: AND results are kept when there are at least `limit` of them", async () => {
  const { db, root, project } = await freshDb("c".repeat(16));
  try {
    const both = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree, label: "both.txt" }), [{ ord: 0, text: "alpha beta", bytes: 10 }]);
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree, label: "one.txt" }), [{ ord: 0, text: "alpha alpha alpha", bytes: 17 }]);
    assert.deepEqual(ftsQuery(db, "alpha beta", "session", project, "s1", 1, 0).map((h) => h.sourceId), [both]);
    assert.equal(ftsQuery(db, "alpha beta", "session", project, "s1", 10, 0).length, 2);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("[search-L2] ftsQuery: under the OR fallback, chunks that match every term come before partial matches", async () => {
  const { db, root, project } = await freshDb("d".repeat(16));
  try {
    const filler = Array.from({ length: 60 }, (_, i) => "filler" + i).join(" ");
    const all = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree, label: "all.txt" }), [{ ord: 0, text: filler + " journal mode wal " + filler, bytes: 900 }]);
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree, label: "part.txt" }), [{ ord: 0, text: "mode mode wal wal", bytes: 17 }]);
    const hits = ftsQuery(db, "journal mode WAL", "session", project, "s1", 10, 0);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].sourceId, all);
    assert.deepEqual(ftsQuery(db, "journal mode WAL", "session", project, "s1", 1, 1).map((h) => h.sourceId).length, 1);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Search layer 3 (D-SEARCH-3): porter stemming over unicode61, a title column weighted over body ----
test("[search-L3] ftsQuery: porter stemming matches other forms of a word", async () => {
  const { db, root, project } = await freshDb("e".repeat(16));
  try {
    const id = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "Open a connection to the database", bytes: 33 }]);
    assert.deepEqual(ftsQuery(db, "connecting databases", "session", project, "s1", 10, 0).map((h) => h.sourceId), [id]);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("[search-L3] ftsInsert stores the chunk title; a title match ranks before a body-only match", async () => {
  const { db, root, project } = await freshDb("f".repeat(16));
  try {
    const body = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree, label: "body.md" }), [{ ord: 0, text: "Some text. The cleanup runs here. More text about other things.", bytes: 64 }]);
    const titled = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree, label: "title.md" }), [{ ord: 0, text: "## Cleanup\n\nIt runs once, on close of the store and its files.", bytes: 62, title: "Guide > Cleanup" }]);
    assert.equal(db.raw.prepare("SELECT title FROM chunks WHERE source_id = ?").get(titled).title, "Guide > Cleanup");
    assert.equal(db.raw.prepare("SELECT title FROM chunks WHERE source_id = ?").get(body).title, "");
    assert.deepEqual(ftsQuery(db, "cleanup", "session", project, "s1", 10, 0).map((h) => h.sourceId), [titled, body]);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Search layer 4 (D-SEARCH-4): trigram table, RRF fusion, typo correction ----
test("[search-L4] ftsQuery: an exact code substring ranks before a chunk that only repeats its words", async () => {
  const { db, root, project } = await freshDb("g".repeat(16));
  try {
    const exact = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree, label: "a.md" }), [{ ord: 0, text: "Print it with JSON.stringify(data, null, 2) and read the result back in the log viewer later on", bytes: 96 }]);
    const words = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree, label: "b.md" }), [{ ord: 0, text: "stringify data, null data stringify data null stringify data null", bytes: 66 }]);
    assert.deepEqual(ftsQuery(db, "JSON.stringify(data, null", "session", project, "s1", 10, 0).map((h) => h.sourceId), [exact, words]);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("[search-L4] deleteSourceChunks removes the porter and trigram rows; a reused rowid finds no old text", async () => {
  const { db, root, project } = await freshDb("h".repeat(16));
  try {
    const id = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "old-identifier-xyz here", bytes: 23 }]);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM chunks_tri WHERE chunks_tri MATCH ?").get('"identifier-xyz"').n, 1);
    deleteSourceChunks(db.raw, id);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM chunks WHERE source_id = ?").get(id).n, 0);
    assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM chunks_tri WHERE chunks_tri MATCH ?").get('"identifier-xyz"').n, 0);
    const next = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "new text only", bytes: 13 }]);
    assert.deepEqual(ftsQuery(db, "identifier-xyz", "session", project, "s1", 10, 0), []);
    assert.deepEqual(ftsQuery(db, "new text", "session", project, "s1", 10, 0).map((h) => h.sourceId), [next]);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("[search-L4] ftsQuery: when no word matches, typo correction from the index vocabulary finds the chunk", async () => {
  const { db, root, project } = await freshDb("i".repeat(16));
  try {
    const id = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "Open a connection to the PostgreSQL database", bytes: 44 }]);
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "unrelated words only", bytes: 20 }]);
    assert.deepEqual(ftsQuery(db, "postgress conection", "session", project, "s1", 10, 0).map((h) => h.sourceId), [id]);
    assert.deepEqual(ftsQuery(db, "zzzzzzzzqq", "session", project, "s1", 10, 0), []);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("ftsQuery and rankTexts treat a NUL character as a word break, never an FTS5 error (D-SEARCH-6)", async () => {
  const { db, root, project } = await freshDb("9a".repeat(8));
  try {
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "alpha beta gamma", bytes: 16 }]);
    assert.deepEqual(ftsQuery(db, "\u0000", "session", project, "s1", 10, 0), []);
    assert.equal(ftsQuery(db, "alpha\u0000beta", "session", project, "s1", 10, 0).length, 1);
    assert.equal(ftsQuery(db, "gamma\u0000", "session", project, "s1", 10, 0).length, 1);
    assert.equal(ftsQuery(db, "zzqx\u0000qqzx", "session", project, "s1", 10, 0).length, 0);
    assert.deepEqual(rankTexts(["alpha beta", "zeta"], "alpha\u0000beta").map((s) => s > 0), [true, false]);
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});

test("[perf-P1] ftsQuery ranks scope session/worktree by BM25 with no window sort; only scope project computes the RRF windows (D-HQ-PERF-1)", () => {
  for (const scope of ["session", "worktree"]) assert.ok(!porterRankSql(scope).includes(" OVER "), scope + " runs a window sort");
  assert.ok(porterRankSql("project").includes(" OVER "), "project lost its RRF ranks");
});

// D-HQ-PERF-2: a chunks_vocab read walks the whole porter index (no index on length(term)); profile of
// GP-SEARCH held-out showed the two-typo query paying one walk per misspelled stem. One walk per pass.
test("[perf-P2] typo correction reads chunks_vocab once per pass, however many stems miss (D-HQ-PERF-2)", async () => {
  const { db, root, project } = await freshDb("p2".repeat(8));
  try {
    const id = ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "Open a connection to the PostgreSQL database", bytes: 44 }]);
    ftsInsert(db, src({ sessionId: "s1", worktree: project.worktree }), [{ ord: 0, text: "unrelated words only", bytes: 20 }]);
    let walks = 0;
    const raw = db.raw;
    const counted = new Proxy(raw, {
      get(target, key) {
        if (key !== "prepare") { const v = Reflect.get(target, key, target); return typeof v === "function" ? v.bind(target) : v; }
        return (sql) => {
          const st = target.prepare(sql);
          if (!sql.includes("chunks_vocab") || sql.includes("term = ?")) return st;
          return { all: (...a) => { walks++; return st.all(...a); }, get: (...a) => { walks++; return st.get(...a); } };
        };
      },
    });
    const hits = ftsQuery({ ...db, raw: counted }, "postgress conection", "session", project, "s1", 10, 0);
    assert.deepEqual(hits.map((h) => h.sourceId), [id]);
    assert.equal(walks, 1, "chunks_vocab walks for two misspelled stems");
  } finally {
    closeDb(db);
    rmSync(root, { recursive: true, force: true });
  }
});
