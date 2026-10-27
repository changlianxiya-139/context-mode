// GEM-WIN-8 (D-WIN-HIDE-1): on Windows a child process of a console program opens its own console window unless
// the spawn options carry windowsHide: true. Setup, doctor and the hook sampler spawn up to HOOK_SAMPLES children,
// so a missing flag shows as flashing windows. This guard reads every .ts file under src with the TypeScript parser
// (not text matching) and fails on any child_process call whose options object lacks `windowsHide: true`.
// It runs on every OS: the property is in the source, not in the platform branch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));
const SPAWNERS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);

function tsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? tsFiles(f) : f.endsWith(".ts") ? [f] : [];
  });
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

function importsChildProcess(sf) {
  let found = false;
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /^(node:)?child_process$/.test(n.moduleSpecifier.text)) found = true;
    if (ts.isStringLiteral(n) && /^(node:)?child_process$/.test(n.text)) found = true; // getBuiltinModule("node:child_process")
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function hidesWindow(call) {
  return call.arguments.some((a) => ts.isObjectLiteralExpression(a) && a.properties.some((p) =>
    ts.isPropertyAssignment(p) && p.name.getText() === "windowsHide" && p.initializer.kind === ts.SyntaxKind.TrueKeyword));
}

test("[WIN] D-WIN-HIDE-1: every child_process call under src sets windowsHide: true", () => {
  const missing = [];
  let calls = 0;
  for (const file of tsFiles(SRC)) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    if (!importsChildProcess(sf)) continue;
    const visit = (n) => {
      if (ts.isCallExpression(n) && SPAWNERS.has(calleeName(n.expression) ?? "")) {
        calls++;
        if (!hidesWindow(n)) missing.push(`${path.relative(SRC, file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  assert.ok(calls >= 10, `the scan must see the known spawn calls, saw ${calls}`);
  assert.deepEqual(missing, [], `child_process calls without windowsHide: true: ${missing.join(", ")}`);
});

test("[WIN] D-WIN-HIDE-1: the scan catches a call without the flag (self-check)", () => {
  const sf = ts.createSourceFile("x.ts", 'import { spawnSync } from "node:child_process"; spawnSync("a", [], { env }); spawnSync("b", [], { windowsHide: true });', ts.ScriptTarget.Latest, true);
  const verdicts = [];
  const visit = (n) => { if (ts.isCallExpression(n) && SPAWNERS.has(calleeName(n.expression) ?? "")) verdicts.push(hidesWindow(n)); ts.forEachChild(n, visit); };
  visit(sf);
  assert.deepEqual(verdicts, [false, true]);
});
