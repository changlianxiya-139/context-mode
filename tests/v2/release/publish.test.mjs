// Unit tests for scripts/release/publish.mjs (impl/13-build-release.md §11.1, DEVIATIONS D-M6-arch-5,
// D-M6-P2-1). Runs the real script against a local bare repo passed via --remote; nothing leaves the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = path.join(REPO, "scripts", "release", "publish.mjs");
const SRC = "0123456789abcdef0123456789abcdef01234567";
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

function publish(cwd, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: ENV });
}

// root/remote.git (bare, `main` with one commit) and root/work: a clone on `main` with a stray file.
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "cm-v2-publish-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, "remote.git");
  const seed = path.join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(root, "init", "-q", "-b", "main", seed);
  writeFileSync(path.join(seed, "source.txt"), "dev tree");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "dev");
  git(seed, "push", "-q", bare, "main");
  const work = path.join(root, "work");
  git(root, "clone", "-q", bare, work);
  return { root, bare, work };
}

// The downloaded artifact: release-out/{server.mjs, hooks/a.json, SHA256SUMS}.
function artifact(dir, body) {
  const out = path.join(dir, "release-out");
  mkdirSync(path.join(out, "hooks"), { recursive: true });
  writeFileSync(path.join(out, "server.mjs"), body);
  writeFileSync(path.join(out, "hooks", "a.json"), "{}");
  writeFileSync(path.join(out, "SHA256SUMS"), `sums ${body}`);
}

const remoteRef = (bare, ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: bare, encoding: "utf8", env: ENV }).stdout.trim();

test("[M6] publish/stage-first: orphan release-staging holds only release-out/*, trailer, local annotated tag", (t) => {
  const { bare, work } = fixture(t);
  artifact(work, "v2.0.0 bundle");
  const r = publish(work, "--stage", "--version", "2.0.0", "--source-commit", SRC, "--remote", bare);
  assert.equal(r.status, 0, r.stderr);

  const head = remoteRef(bare, "refs/heads/release-staging");
  assert.equal(head, git(work, "rev-parse", "HEAD"));
  assert.equal(git(bare, "rev-list", "--count", "release-staging"), "1", "orphan: no dev history");
  assert.deepEqual(git(bare, "ls-tree", "-r", "--name-only", "release-staging").split("\n"), ["SHA256SUMS", "hooks/a.json", "server.mjs"]);
  assert.equal(git(bare, "show", "release-staging:server.mjs"), "v2.0.0 bundle");
  assert.equal(git(bare, "log", "-1", "--format=%s", "release-staging"), "release v2.0.0");
  assert.equal(git(bare, "log", "-1", "--format=%(trailers:key=Source-Commit,valueonly)", "release-staging"), SRC);

  assert.equal(git(work, "cat-file", "-t", "refs/tags/v2.0.0"), "tag", "annotated tag");
  assert.equal(git(work, "rev-parse", "v2.0.0^{commit}"), head);
  assert.equal(remoteRef(bare, "refs/tags/v2.0.0"), "", "draft tag is not pushed by --stage");
  assert.deepEqual(readdirSync(work).sort(), [".git", "SHA256SUMS", "hooks", "server.mjs"]);
});

test("[M6] publish/stage-next: an existing release-staging gets one child commit; old files go", (t) => {
  const { root, bare, work } = fixture(t);
  artifact(work, "one");
  writeFileSync(path.join(work, "release-out", "old.txt"), "gone next time");
  assert.equal(publish(work, "--stage", "--version", "2.0.0", "--source-commit", SRC, "--remote", bare).status, 0);
  const first = remoteRef(bare, "refs/heads/release-staging");

  const next = path.join(root, "next");
  git(root, "clone", "-q", "--branch", "release-staging", bare, next);
  artifact(next, "two");
  const src2 = "f".repeat(40);
  const r = publish(next, "--stage", "--version", "2.1.0", "--source-commit", src2, "--remote", bare);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(bare, "rev-parse", "release-staging^"), first);
  assert.equal(git(bare, "show", "release-staging:server.mjs"), "two");
  assert.ok(!git(bare, "ls-tree", "-r", "--name-only", "release-staging").split("\n").includes("old.txt"));
  assert.equal(git(bare, "log", "-1", "--format=%(trailers:key=Source-Commit,valueonly)", "release-staging"), src2);
});

test("[M6] publish/stage-lease: a release-staging that moved after the check is not overwritten", (t) => {
  const { root, bare, work } = fixture(t);
  // A stale view: the work clone thinks release-staging is absent, but it now exists on the remote.
  const other = path.join(root, "other");
  git(root, "clone", "-q", bare, other);
  artifact(other, "other");
  assert.equal(publish(other, "--stage", "--version", "2.0.0", "--source-commit", SRC, "--remote", bare).status, 0);
  const theirs = remoteRef(bare, "refs/heads/release-staging");
  // The script reads the remote head itself, so a second stage builds on top (no lost commit).
  artifact(work, "mine");
  const r = publish(work, "--stage", "--version", "2.0.1", "--source-commit", SRC, "--remote", bare);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(bare, "rev-parse", "release-staging^"), theirs);
});

test("[M6] publish/promote: release = release-staging commit, tag pushed, gh skipped for a non-origin remote", (t) => {
  const { root, bare, work } = fixture(t);
  artifact(work, "bundle");
  assert.equal(publish(work, "--stage", "--version", "2.0.0", "--source-commit", SRC, "--remote", bare).status, 0);
  const staged = remoteRef(bare, "refs/heads/release-staging");

  // publish-promote runs in a fresh checkout: the draft tag is not there; it is made on the staged commit.
  const fresh = path.join(root, "fresh");
  git(root, "clone", "-q", bare, fresh);
  const r = publish(fresh, "--promote", "--version", "2.0.0", "--notes", "n", "--remote", bare);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteRef(bare, "refs/heads/release"), staged);
  assert.equal(git(bare, "cat-file", "-t", "refs/tags/v2.0.0"), "tag");
  assert.equal(git(bare, "rev-parse", "v2.0.0^{commit}"), staged);
  assert.ok(r.stdout.includes("gh release skipped"), r.stdout);

  // Promote in the stage checkout reuses its local draft tag.
  artifact(work, "bundle 2");
  assert.equal(publish(work, "--stage", "--version", "2.0.1", "--source-commit", SRC, "--remote", bare).status, 0);
  const r2 = publish(work, "--promote", "--version", "2.0.1", "--remote", bare);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(remoteRef(bare, "refs/heads/release"), remoteRef(bare, "refs/heads/release-staging"));
  assert.equal(git(bare, "rev-parse", "release^"), staged, "release moved forward by one commit");
});

test("[M6] publish/promote-tag-mismatch: a local tag on another commit fails, release untouched", (t) => {
  const { bare, work } = fixture(t);
  artifact(work, "bundle");
  assert.equal(publish(work, "--stage", "--version", "2.0.0", "--source-commit", SRC, "--remote", bare).status, 0);
  git(work, "tag", "-f", "-a", "v2.0.0", "-m", "v2.0.0", "main");
  const r = publish(work, "--promote", "--version", "2.0.0", "--remote", bare);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.startsWith("release failed: tag v2.0.0 points at"), r.stderr);
  assert.equal(remoteRef(bare, "refs/heads/release"), "");
});

test("[M6] publish/promote-no-staging and bad arguments: one 'release failed:' line, exit 1", (t) => {
  const { bare, work } = fixture(t);
  const cases = [
    [["--promote", "--version", "2.0.0", "--remote", bare], "release failed: release-staging does not exist on"],
    [["--stage", "--promote", "--version", "2.0.0"], "release failed: pass exactly one of --stage or --promote"],
    [["--stage", "--version", "2.0", "--source-commit", SRC], "release failed: --version <x.y.z> is required"],
    [["--stage", "--version", "2.0.0", "--source-commit", "abc"], "release failed: --stage needs --source-commit"],
    [["--stage", "--version", "2.0.0", "--source-commit", SRC, "--remote", bare], "release failed: release-out/SHA256SUMS not found"],
    [["--bogus"], "release failed: unknown argument --bogus"],
  ];
  for (const [args, want] of cases) {
    const r = publish(work, ...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.ok(r.stderr.startsWith(want), `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stderr.trim().split("\n").length, 1);
  }
  assert.equal(readFileSync(path.join(work, "source.txt"), "utf8"), "dev tree", "a failed stage changes no file");
});

// D-FU-RF-1: a release branch with only untagged (rehearsal) commits is replaced; a tagged release is never dropped.
// root/work has a commit pushed as `release` on the bare remote; `tagged` also pushes an annotated v2.0.0 tag on it.
function seedRelease(work, bare, tagged) {
  writeFileSync(path.join(work, "rehearsal.txt"), "old");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "rehearsal build");
  git(work, "push", "-q", bare, "HEAD:refs/heads/release");
  if (tagged) {
    git(work, "tag", "-a", "v2.0.0", "-m", "v2.0.0");
    git(work, "push", "-q", bare, "refs/tags/v2.0.0");
  }
  return git(work, "rev-parse", "HEAD");
}

test("[M6] publish/promote-rehearsal: an untagged release branch is replaced by the staged commit", (t) => {
  const { root, bare, work } = fixture(t);
  const rehearsal = seedRelease(work, bare, false);
  const fresh = path.join(root, "fresh");
  git(root, "clone", "-q", bare, fresh);
  artifact(fresh, "real build");
  assert.equal(publish(fresh, "--stage", "--version", "2.0.0", "--source-commit", SRC, "--remote", bare).status, 0);
  const staged = remoteRef(bare, "refs/heads/release-staging");
  const r = publish(fresh, "--promote", "--version", "2.0.0", "--remote", bare);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteRef(bare, "refs/heads/release"), staged);
  assert.notEqual(remoteRef(bare, "refs/heads/release"), rehearsal);
  assert.equal(git(bare, "cat-file", "-t", "refs/tags/v2.0.0"), "tag");
});

test("[M6] publish/promote-tagged: a tagged release that the staged commit does not contain is not dropped", (t) => {
  const { root, bare, work } = fixture(t);
  const tagged = seedRelease(work, bare, true);
  // release-staging was built without that history (an unrelated orphan).
  const other = path.join(root, "other");
  git(root, "init", "-q", "-b", "main", other);
  artifact(other, "unrelated");
  assert.equal(publish(other, "--stage", "--version", "2.0.1", "--source-commit", SRC, "--remote", bare).status, 0);
  const r = publish(other, "--promote", "--version", "2.0.1", "--remote", bare);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.startsWith(`release failed: tagged release v2.0.0 (${tagged}) is not in release-staging; refusing`), r.stderr);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.equal(remoteRef(bare, "refs/heads/release"), tagged, "release untouched");
  assert.equal(remoteRef(bare, "refs/tags/v2.0.1"), "", "no tag pushed");
});

test("[M6] publish/promote-tagged-ok: a staged commit that contains the tagged release is promoted", (t) => {
  const { root, bare, work } = fixture(t);
  const tagged = seedRelease(work, bare, true);
  git(work, "push", "-q", bare, "HEAD:refs/heads/release-staging");
  const next = path.join(root, "next");
  git(root, "clone", "-q", "--branch", "release-staging", bare, next);
  artifact(next, "next build");
  assert.equal(publish(next, "--stage", "--version", "2.0.1", "--source-commit", SRC, "--remote", bare).status, 0);
  const r = publish(next, "--promote", "--version", "2.0.1", "--remote", bare);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(bare, "rev-parse", "release^"), tagged);
});

// Release-next (D-RN-TAG-1): release.yml started by a pushed v2.* tag. The tag already sits on the source
// commit on the remote; stage and promote reuse it: no second tag, no tag push, no refusal.
const posixGh = { skip: process.platform === "win32" ? "stub gh is a sh script" : false };

function pushTag(work, remote, name, ref = "HEAD") {
  git(work, "tag", "-a", name, "-m", name, ref);
  git(work, "push", "-q", remote, `refs/tags/${name}`);
  return git(work, "rev-parse", `refs/tags/${name}^{commit}`);
}

test("[RN] publish/stage-reuse-tag: a pushed tag on the source commit is reused, not created again", (t) => {
  const { bare, work } = fixture(t);
  const src = pushTag(work, bare, "v2.0.0-next.1");
  const tagObject = remoteRef(bare, "refs/tags/v2.0.0-next.1");
  artifact(work, "next build");
  const r = publish(work, "--stage", "--version", "2.0.0-next.1", "--source-commit", src, "--remote", bare);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("tag v2.0.0-next.1 already on"), r.stdout);
  assert.equal(remoteRef(bare, "refs/tags/v2.0.0-next.1"), tagObject, "remote tag untouched");
  assert.equal(git(work, "rev-parse", "refs/tags/v2.0.0-next.1^{commit}"), src, "local tag not moved to the staged commit");
  assert.ok(git(work, "log", "-1", "--format=%B", "release-staging").includes(`Source-Commit: ${src}`));
});

test("[RN] publish/stage-reuse-tag-mismatch: a pushed tag on another commit than --source-commit -> refuse", (t) => {
  const { bare, work } = fixture(t);
  const src = pushTag(work, bare, "v2.0.0-next.1");
  artifact(work, "next build");
  const r = publish(work, "--stage", "--version", "2.0.0-next.1", "--source-commit", SRC, "--remote", bare);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `release failed: tag v2.0.0-next.1 on ${bare} points at ${src}, not source commit ${SRC}\n`);
  assert.equal(remoteRef(bare, "refs/heads/release-staging"), "", "nothing staged");
});

test("[RN] publish/promote-reuse-tag: release moves to the staged commit; the pushed tag is not pushed again", (t) => {
  const { root, bare, work } = fixture(t);
  const src = pushTag(work, bare, "v2.0.0-next.1");
  const tagObject = remoteRef(bare, "refs/tags/v2.0.0-next.1");
  artifact(work, "next build");
  assert.equal(publish(work, "--stage", "--version", "2.0.0-next.1", "--source-commit", src, "--remote", bare).status, 0);
  const staged = remoteRef(bare, "refs/heads/release-staging");
  const fresh = path.join(root, "fresh");
  git(root, "clone", "-q", bare, fresh);
  const r = publish(fresh, "--promote", "--version", "2.0.0-next.1", "--remote", bare);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteRef(bare, "refs/heads/release"), staged);
  assert.equal(remoteRef(bare, "refs/tags/v2.0.0-next.1"), tagObject, "remote tag untouched");
  assert.equal(remoteRef(bare, "refs/tags/v2.0.0-next.1^{commit}"), src);
});

test("[RN] publish/promote-reuse-tag-mismatch: a pushed tag that is not the staged Source-Commit -> refuse, release untouched", (t) => {
  const { bare, work } = fixture(t);
  const main = git(work, "rev-parse", "HEAD");
  artifact(work, "build");
  assert.equal(publish(work, "--stage", "--version", "2.0.0-next.1", "--source-commit", SRC, "--remote", bare).status, 0);
  const staged = remoteRef(bare, "refs/heads/release-staging");
  git(work, "tag", "-d", "v2.0.0-next.1");
  git(work, "tag", "-a", "v2.0.0-next.1", "-m", "x", main);
  git(work, "push", "-q", bare, "refs/tags/v2.0.0-next.1");
  const r = publish(work, "--promote", "--version", "2.0.0-next.1", "--remote", bare);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `release failed: tag v2.0.0-next.1 on ${bare} points at ${main}, not Source-Commit ${SRC} of release-staging ${staged}\n`);
  assert.equal(remoteRef(bare, "refs/heads/release"), "");
});

test("[RN] publish/version-prerelease: --version takes x.y.z-<prerelease>; bad prerelease parts fail", (t) => {
  const { work } = fixture(t);
  for (const bad of ["2.0.0-", "2.0.0-next..1", "2.0.0-next.01", "2.0.0+b", "v2.0.0-next.1"]) {
    const r = publish(work, "--stage", "--version", bad, "--source-commit", SRC);
    assert.equal(r.status, 1, bad);
    assert.equal(r.stderr, "release failed: --version <x.y.z> is required\n", bad);
  }
});

// Stub gh: logs its argv to <bin>/argv.
function stubGh(t) {
  const bin = mkdtempSync(path.join(tmpdir(), "cm-v2-gh-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$@" > "${bin}/argv"\n`, { mode: 0o755 });
  return bin;
}

test("[RN] publish/gh-prerelease: a version with a '-' part is a prerelease and never Latest; x.y.z is unchanged", posixGh, (t) => {
  for (const [version, pre] of [["2.0.0-next.1", true], ["2.0.0", false]]) {
    const { bare, work } = fixture(t);
    const src = pre ? pushTag(work, bare, `v${version}`) : SRC;
    artifact(work, "b");
    assert.equal(publish(work, "--stage", "--version", version, "--source-commit", src).status, 0);
    const bin = stubGh(t);
    const env = { ...ENV, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const r = spawnSync(process.execPath, [SCRIPT, "--promote", "--version", version, "--notes", "n"], { cwd: work, encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    // D-RN-ORDER-1: the GitHub release is its own step, run only after npm publish.
    const g = spawnSync(process.execPath, [SCRIPT, "--github-release", "--version", version, "--notes", "n"], { cwd: work, encoding: "utf8", env });
    assert.equal(g.status, 0, g.stderr);
    const argv = readFileSync(path.join(bin, "argv"), "utf8").trim().split(" ");
    assert.deepEqual(argv.slice(0, 4), ["release", "create", `v${version}`, "--verify-tag"], version);
    assert.equal(argv.includes("--prerelease"), pre, version);
    assert.equal(argv.includes("--latest=false"), pre, version);
    assert.ok(!argv.includes("--latest") && !argv.includes("--latest=true"), version);
    assert.equal(remoteRef(bare, `refs/tags/v${version}^{commit}`), pre ? src : remoteRef(bare, "refs/heads/release"), version);
  }
});

// D-RN-ORDER-1: run 40496186557 (v2.0.0-next.4) made the GitHub prerelease in publish-promote, then npm publish
// failed, so GitHub showed a release that npm did not have. --promote now moves `release` and pushes the tag only;
// --github-release makes the GitHub release, and release.yml runs it only after publish-npm succeeds.
test("[N5] publish/promote-no-gh: promote on origin moves release and pushes the tag, but makes no GitHub release (D-RN-ORDER-1)", posixGh, (t) => {
  const { bare, work } = fixture(t);
  artifact(work, "b");
  assert.equal(publish(work, "--stage", "--version", "2.0.0-next.5", "--source-commit", SRC).status, 0);
  const staged = remoteRef(bare, "refs/heads/release-staging");
  const bin = stubGh(t);
  const env = { ...ENV, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const r = spawnSync(process.execPath, [SCRIPT, "--promote", "--version", "2.0.0-next.5"], { cwd: work, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(remoteRef(bare, "refs/heads/release"), staged);
  assert.equal(remoteRef(bare, "refs/tags/v2.0.0-next.5^{commit}"), staged);
  assert.equal(existsSync(path.join(bin, "argv")), false, "promote never calls gh");
});

test("[N5] publish/github-release: makes the GitHub release for the pushed tag with SHA256SUMS (D-RN-ORDER-1)", posixGh, (t) => {
  const { bare, work } = fixture(t);
  const src = pushTag(work, bare, "v2.0.0-next.5");
  artifact(work, "b");
  const bin = stubGh(t);
  const env = { ...ENV, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const r = spawnSync(process.execPath, [SCRIPT, "--github-release", "--version", "2.0.0-next.5", "--notes", "n"], { cwd: work, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(path.join(bin, "argv"), "utf8").trim(),
    `release create v2.0.0-next.5 --verify-tag --prerelease --latest=false --title v2.0.0-next.5 --notes n ${path.join("release-out", "SHA256SUMS")}`);
  assert.equal(remoteRef(bare, "refs/tags/v2.0.0-next.5^{commit}"), src, "tag untouched");
});

test("[N5] publish/github-release-no-tag: the tag is not on the remote -> refuse, gh not called (D-RN-ORDER-1)", posixGh, (t) => {
  const { work } = fixture(t);
  artifact(work, "b");
  const bin = stubGh(t);
  const env = { ...ENV, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const r = spawnSync(process.execPath, [SCRIPT, "--github-release", "--version", "2.0.0-next.5", "--notes", "n"], { cwd: work, encoding: "utf8", env });
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "release failed: tag v2.0.0-next.5 is not on origin; promote pushes it first\n");
  assert.equal(existsSync(path.join(bin, "argv")), false);
});

test("[N5] publish/github-release-args: exactly one mode; --github-release needs --version (D-RN-ORDER-1)", (t) => {
  const { work } = fixture(t);
  const cases = [
    [["--github-release", "--promote", "--version", "2.0.0"], "release failed: pass exactly one of --stage, --promote or --github-release\n"],
    [["--github-release"], "release failed: --version <x.y.z> is required\n"],
  ];
  for (const [args, want] of cases) {
    const r = publish(work, ...args);
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stderr, want, args.join(" "));
  }
});

test("[N5] publish/github-release-non-origin: a non-default remote skips gh, as promote did (D-M6-arch-5)", (t) => {
  const { bare, work } = fixture(t);
  pushTag(work, bare, "v2.0.0");
  artifact(work, "b");
  const r = publish(work, "--github-release", "--version", "2.0.0", "--notes", "n", "--remote", bare);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("gh release skipped"), r.stdout);
});
