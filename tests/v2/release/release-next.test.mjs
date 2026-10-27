// Release-next dry run (DEVIATIONS D-RN-TAG-1): the release.yml path for a pushed v2.* tag, run locally against
// a bare temp remote. plan.mjs --tag -> publish.mjs --stage -> publish.mjs --promote (fresh checkout) -> publish.mjs
// --github-release (fresh checkout) with a stub gh. Nothing leaves the machine; npm is never called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PLAN = path.join(REPO, "scripts", "release", "plan.mjs");
const PUBLISH = path.join(REPO, "scripts", "release", "publish.mjs");
const TAG = "v2.0.0-next.1";
const VERSION = "2.0.0-next.1";
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const node = (cwd, script, args, env = ENV) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env });
const remoteRef = (bare, ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: bare, encoding: "utf8", env: ENV }).stdout.trim();

test("[RN] release-next dry run: tag v2.0.0-next.1 -> plan, stage, promote; one tag, prerelease, never Latest", {
  skip: process.platform === "win32" ? "stub gh is a sh script" : false,
}, (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "cm-v2-release-next-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, "remote.git");
  const dev = path.join(root, "dev");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(root, "init", "-q", "-b", "main", dev);
  for (const s of ["feat: first feature", "fix: a fix", "docs: no note"]) {
    writeFileSync(path.join(dev, "f.txt"), s);
    git(dev, "add", "-A");
    git(dev, "commit", "-qm", s);
  }
  git(dev, "remote", "add", "origin", bare);
  git(dev, "push", "-q", "origin", "main");
  // The owner's trigger: an annotated tag pushed to origin.
  git(dev, "tag", "-a", TAG, "-m", TAG);
  git(dev, "push", "-q", "origin", `refs/tags/${TAG}`);
  const src = git(dev, "rev-parse", "HEAD");
  const tagObject = remoteRef(bare, `refs/tags/${TAG}`);

  // plan job: fresh full checkout at the tag, ref_type=tag, ref_name=v2.0.0-next.1.
  const planDir = path.join(root, "plan");
  git(root, "clone", "-q", bare, planDir);
  git(planDir, "checkout", "-q", "--detach", src);
  const p = node(planDir, PLAN, ["--tag", TAG]);
  assert.equal(p.status, 0, p.stderr);
  const out = p.stdout.split("\n");
  assert.equal(out[0], `version=${VERSION}`);
  assert.ok(p.stdout.includes("- feat: first feature") && p.stdout.includes("- fix: a fix"), p.stdout);
  assert.ok(!p.stdout.includes("docs: no note"), p.stdout);
  const notes = p.stdout.slice(p.stdout.indexOf("notes<<EOF\n") + "notes<<EOF\n".length, p.stdout.lastIndexOf("\nEOF\n"));

  // publish-stage job: checkout of the source commit plus the downloaded artifact.
  const stageDir = path.join(root, "stage");
  git(root, "clone", "-q", bare, stageDir);
  git(stageDir, "checkout", "-q", "--detach", src);
  mkdirSync(path.join(stageDir, "release-out"));
  writeFileSync(path.join(stageDir, "release-out", "server.mjs"), "built");
  writeFileSync(path.join(stageDir, "release-out", "SHA256SUMS"), "sums");
  const s = node(stageDir, PUBLISH, ["--stage", "--version", VERSION, "--source-commit", src]);
  assert.equal(s.status, 0, s.stderr);
  const staged = remoteRef(bare, "refs/heads/release-staging");
  assert.notEqual(staged, "");
  assert.equal(remoteRef(bare, `refs/tags/${TAG}`), tagObject, "stage leaves the pushed tag alone");

  // publish-promote job: fresh checkout, artifact, stub gh on PATH, default remote origin.
  const promoteDir = path.join(root, "promote");
  git(root, "clone", "-q", bare, promoteDir);
  git(promoteDir, "checkout", "-q", "--detach", src);
  mkdirSync(path.join(promoteDir, "release-out"));
  writeFileSync(path.join(promoteDir, "release-out", "SHA256SUMS"), "sums");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a"; done > "${bin}/argv"\n`, { mode: 0o755 });
  const env = { ...ENV, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const r = node(promoteDir, PUBLISH, ["--promote", "--version", VERSION], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(path.join(bin, "argv")), false, "promote makes no GitHub release (D-RN-ORDER-1)");

  // publish-npm runs here (not in this test). github-release job, only after it succeeds: fresh checkout, artifact.
  const ghDir = path.join(root, "gh-release");
  git(root, "clone", "-q", bare, ghDir);
  git(ghDir, "checkout", "-q", "--detach", src);
  mkdirSync(path.join(ghDir, "release-out"));
  writeFileSync(path.join(ghDir, "release-out", "SHA256SUMS"), "sums");
  const g = node(ghDir, PUBLISH, ["--github-release", "--version", VERSION, "--notes", notes], env);
  assert.equal(g.status, 0, g.stderr);

  assert.equal(remoteRef(bare, "refs/heads/release"), staged, "release = release-staging");
  assert.equal(remoteRef(bare, `refs/tags/${TAG}`), tagObject, "one tag: the pushed one, never re-made");
  assert.equal(remoteRef(bare, `refs/tags/${TAG}^{commit}`), src);
  const tags = git(bare, "tag", "-l");
  assert.equal(tags, TAG, "no second tag on the remote");
  const argv = readFileSync(path.join(bin, "argv"), "utf8").split("\0").slice(0, -1); // NUL: notes span lines
  assert.deepEqual(argv, ["release", "create", TAG, "--verify-tag", "--prerelease", "--latest=false",
    "--title", TAG, "--notes", notes, path.join("release-out", "SHA256SUMS")]);
});
