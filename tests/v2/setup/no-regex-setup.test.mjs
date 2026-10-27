// No regex in the setup runtime (rule: no regex as a mechanism). The TypeScript parser finds the nodes.
// CP-WIN-6: spawn-bin.ts quotes with a char loop; the leftovers in print.ts and engine.ts went the same way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { shellWord } from "../../../src/setup/index.ts";

const FILES = [...readdirSync("src/setup").filter((f) => f.endsWith(".ts")).map((f) => `src/setup/${f}`), "src/core/sandbox/path-entries.ts"];

function regexNodes(path) {
  const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) found.push(node.getText(sf));
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === "RegExp") found.push(node.getText(sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

for (const path of FILES) {
  test("no regex literal or RegExp call in " + path, () => {
    assert.deepEqual(regexNodes(path), []);
  });
}

test("shellWord: safe words stay bare, everything else is single-quoted (same output as before)", () => {
  for (const w of ["abc", "a/b-c.d", "x=1", "a@b+c", "50%", "C:/x", "a,b", "A_9"]) assert.equal(shellWord(w), w);
  assert.equal(shellWord(""), "''");
  assert.equal(shellWord("a b"), "'a b'");
  assert.equal(shellWord("it's"), `'it'"'"'s'`);
  assert.equal(shellWord("C:\\x"), "'C:\\x'");
  assert.equal(shellWord("a$b"), "'a$b'");
  assert.equal(shellWord("é"), "'é'");
});
