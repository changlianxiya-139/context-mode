// D-VT-WINBASH-1: on Windows the shell is Git Bash, found from the installed Git. A bash.exe on PATH is never used:
// %LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe is an App Execution Alias (node cannot spawn it: EACCES) and
// C:\Windows\System32\bash.exe is the WSL launcher (a different filesystem). Fake layouts run on every OS (platform spoof).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { findRuntime } from "../../../src/core/sandbox/runtimes.ts";
import { runProcess } from "../../../src/core/sandbox/spawn.ts";
import { ctxExecute } from "../../../src/core/tools/execute.ts";
import { runBatch } from "../../../src/core/tools/batch.ts";
import { checkShell } from "../../../src/core/ops/doctor-env.ts";
import { formatError } from "../../../src/core/contracts/errors.ts";

const PATHEXT = ".COM;.EXE;.BAT;.CMD";

async function asWindows(env, fn) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  const saved = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", real);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Layout of Git for Windows: <root>\cmd\git.exe, <root>\bin\git.exe, <root>\bin\bash.exe, <root>\mingw64\bin\git.exe.
function layout() {
  const top = mkdtempSync(join(tmpdir(), "cm-gb-"));
  const apps = join(top, "Microsoft", "WindowsApps");
  const sys32 = join(top, "Windows", "System32");
  const git = join(top, "Program Files", "Git");
  for (const d of [apps, sys32, join(git, "cmd"), join(git, "bin"), join(git, "mingw64", "bin")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(apps, "bash.exe"), "");
  writeFileSync(join(sys32, "bash.exe"), "");
  writeFileSync(join(git, "bin", "bash.exe"), "");
  writeFileSync(join(git, "bin", "git.exe"), "");
  writeFileSync(join(git, "cmd", "git.exe"), "");
  writeFileSync(join(git, "mingw64", "bin", "git.exe"), "");
  return { top, apps, sys32, git, bash: join(git, "bin", "bash.exe") };
}
const sep = delimiter; // the spoof keeps the real path module: ":" on POSIX, ";" on Windows

test("[VT-WIN] shell on Windows: the WindowsApps alias dir first, Git dir later -> Git's bash.exe", async () => {
  const l = layout();
  try {
    const found = await asWindows({ PATH: [l.apps, l.sys32, join(l.git, "cmd")].join(sep), PATHEXT }, () => findRuntime("shell"));
    assert.equal(found, l.bash);
  } finally { rmSync(l.top, { recursive: true, force: true }); }
});

test("[VT-WIN] shell on Windows: git.exe in <root>\\bin and in <root>\\mingw64\\bin both find <root>\\bin\\bash.exe", async () => {
  const l = layout();
  try {
    for (const dir of [join(l.git, "bin"), join(l.git, "mingw64", "bin")]) {
      const found = await asWindows({ PATH: [l.apps, dir].join(sep), PATHEXT }, () => findRuntime("shell"));
      assert.equal(found, l.bash, dir);
    }
  } finally { rmSync(l.top, { recursive: true, force: true }); }
});

test("[VT-WIN] shell on Windows: only WindowsApps and System32 bash.exe on PATH, no Git -> null (never the alias)", async () => {
  const l = layout();
  try {
    const found = await asWindows({ PATH: [l.apps, l.sys32].join(sep), PATHEXT }, () => findRuntime("shell"));
    assert.equal(found, null);
  } finally { rmSync(l.top, { recursive: true, force: true }); }
});

test("[VT-WIN] shell on Windows: a bash.exe in a PATH dir is not used even when no alias dir is named; Git without bash -> null", async () => {
  const l = layout();
  try {
    rmSync(l.bash);
    const other = join(l.top, "msys64");
    mkdirSync(other);
    writeFileSync(join(other, "bash.exe"), "");
    const found = await asWindows({ PATH: [other, join(l.git, "cmd")].join(sep), PATHEXT }, () => findRuntime("shell"));
    assert.equal(found, null);
  } finally { rmSync(l.top, { recursive: true, force: true }); }
});

test("[VT-WIN] languages bash and sh on Windows use the same resolver as shell", async () => {
  const l = layout();
  try {
    const env = { PATH: [l.apps, join(l.git, "cmd")].join(sep), PATHEXT };
    const got = await asWindows(env, () => [findRuntime("bash"), findRuntime("sh")]);
    assert.deepEqual(got, [l.bash, l.bash]);
    const none = await asWindows({ PATH: l.apps, PATHEXT }, () => [findRuntime("bash"), findRuntime("sh")]);
    assert.deepEqual(none, [null, null]);
  } finally { rmSync(l.top, { recursive: true, force: true }); }
});

test("[VT-WIN] shell on Windows reads the env it is given", async () => {
  const l = layout();
  try {
    const found = await asWindows({ PATH: l.apps, PATHEXT }, () => findRuntime("shell", { PATH: join(l.git, "cmd"), PATHEXT }));
    assert.equal(found, l.bash);
  } finally { rmSync(l.top, { recursive: true, force: true }); }
});

test("[VT-WIN] POSIX shell lookup is unchanged: sh", () => {
  if (process.platform === "win32") return;
  const p = findRuntime("shell");
  assert.ok(p && p.endsWith("sh"));
});

test("[VT-WIN] NO_GIT_BASH is one line that names the fix", () => {
  assert.equal(formatError("NO_GIT_BASH", {}), "Git Bash not found. Fix: install Git for Windows.");
});

test("[VT-WIN] ctx_execute shell on Windows with no Git Bash: the one NO_GIT_BASH line, no other shell is tried", async () => {
  const l = layout();
  const root = mkdtempSync(join(tmpdir(), "cm-gb-x-"));
  try {
    const ctx = { project: { projectKey: "1".repeat(16), projectDir: join(root, "p"), dbPath: join(root, "p", "context.db"), worktree: root, containmentRoot: root, agent: "claude-code", source: "env:CLAUDE_PROJECT_DIR" }, sessionId: "s1", turn: 1, signal: new AbortController().signal };
    const out = await asWindows({ PATH: [l.apps, l.sys32].join(sep), PATHEXT }, () => ctxExecute.handler({ language: "shell", code: "echo hi" }, ctx));
    assert.equal(out.isError, true);
    assert.equal(out.text, "Git Bash not found. Fix: install Git for Windows.");
  } finally { rmSync(l.top, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("[VT-WIN] ctx_batch on Windows with no Git Bash: each command block carries the NO_GIT_BASH line", async () => {
  const l = layout();
  const root = mkdtempSync(join(tmpdir(), "cm-gb-b-"));
  try {
    const ctx = { project: { projectKey: "1".repeat(16), projectDir: join(root, "projects", "1".repeat(16)), dbPath: join(root, "projects", "1".repeat(16), "context.db"), worktree: root, containmentRoot: root, agent: "claude-code", source: "env:CLAUDE_PROJECT_DIR" }, sessionId: "s1", turn: 1, signal: new AbortController().signal };
    const out = await asWindows({ PATH: [l.apps, l.sys32].join(sep), PATHEXT }, () => runBatch({ commands: ["echo hi"], queries: ["hi"] }, ctx, 5000, 1 << 20));
    assert.ok(out.text.includes("Git Bash not found. Fix: install Git for Windows."), out.text);
    assert.equal(out.text.includes("No shell runtime"), false);
  } finally { rmSync(l.top, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
});

test("[VT-WIN] doctor D11 shell: PASS names the resolved shell; Windows without Git Bash is FAIL with the fix", async () => {
  const l = layout();
  try {
    const ok = await asWindows({ PATH: [l.apps, join(l.git, "cmd")].join(sep), PATHEXT }, () => checkShell(process.env));
    assert.deepEqual(ok, { id: "D11", label: "shell", status: "PASS", detail: "Git Bash: " + l.bash });
    const bad = await asWindows({ PATH: [l.apps, l.sys32].join(sep), PATHEXT }, () => checkShell(process.env));
    assert.deepEqual(bad, { id: "D11", label: "shell", status: "FAIL", detail: "Git Bash not found", fixCommand: "install Git for Windows" });
  } finally { rmSync(l.top, { recursive: true, force: true }); }
});

test("[VT-WIN] doctor D11 shell on POSIX with no sh on PATH is FAIL naming sh", () => {
  if (process.platform === "win32") return;
  const row = checkShell({ PATH: "/nonexistent-dir" });
  assert.equal(row.status, "FAIL");
  assert.equal(row.id, "D11");
});

// Windows-only (CI windows-latest has Git for Windows): the resolved bash starts and runs a command.
test("[VT-WIN] Windows only: the resolved shell is Git's bash.exe and runs a command", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const bash = findRuntime("shell");
  assert.ok(bash, "Git for Windows must be installed");
  const lower = bash.toLowerCase();
  assert.equal(lower.includes("windowsapps"), false);
  assert.equal(lower.includes("\\system32\\"), false);
  const r = await runProcess([bash, "-c", "echo git-bash-ok"], { cwd: process.cwd(), env: process.env, signal: new AbortController().signal, timeoutMs: 20000 });
  assert.equal(r.exitCode, 0, r.stderr.toString("utf8"));
  assert.equal(r.stdout.toString("utf8").trim(), "git-bash-ok");
});

test("[VT-WIN] Windows only: ctx_execute shell and ctx_batch run through Git Bash", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cm-gb-w-"));
  try {
    const ctx = { project: { projectKey: "1".repeat(16), projectDir: join(root, "projects", "1".repeat(16)), dbPath: join(root, "projects", "1".repeat(16), "context.db"), worktree: root, containmentRoot: root, agent: "claude-code", source: "env:CLAUDE_PROJECT_DIR" }, sessionId: "s1", turn: 1, signal: new AbortController().signal };
    const out = await ctxExecute.handler({ language: "shell", code: "echo hi-exec" }, ctx);
    assert.equal(out.isError, false, out.text);
    assert.ok(out.text.includes("hi-exec"));
    const b = await runBatch({ commands: ["echo hi-batch"], queries: ["hi-batch"] }, ctx, 20000, 1 << 20);
    assert.equal(b.isError, false, b.text);
    assert.ok(b.text.includes("hi-batch"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("[W-CODEX-6] findRuntime on Windows: a PATH entry wrapped in double quotes is found (fake win32 on any OS)", async () => {
  const l = layout();
  try {
    const quoted = [`"${l.apps}"`, `"${join(l.git, "cmd")}"`].join(sep);
    assert.equal(await asWindows({ PATH: quoted, PATHEXT }, () => findRuntime("shell")), l.bash, "shell: git.exe in a quoted entry");
    assert.equal(await asWindows({ PATH: `"${join(l.git, "bin")}"`, PATHEXT: ".exe;.cmd" }, () => findRuntime("git")), join(l.git, "bin", "git.exe"), "any runtime in a quoted entry");
  } finally { rmSync(l.top, { recursive: true, force: true }); }
});
