# Install context-mode v2 on ZCode

## Install

```sh
npm i -g context-mode@next
context-mode setup --agents zcode
```

Update:

```sh
context-mode upgrade
```

Check: `context-mode doctor`

ZCode has no install command of its own that takes the package, so setup is the install path here. `next` is the v2 prerelease tag on npm (`npm i -g context-mode@next` also gives the `context-mode` command for doctor). `latest` stays on the old release.

With no terminal (a script or CI), add `--yes`: `context-mode setup --yes --agents zcode`. Without it, setup stops with exit 2.

Restart ZCode after setup.

On Windows the files are `%USERPROFILE%\.zcode\cli\config.json` and `%USERPROFILE%\.zcode\skills`. ZCode takes its home from the OS profile dir and ignores `HOME`, so setup does the same: Git Bash or MSYS with another `HOME` changes nothing. ZCode source read (zai-org/ZCode `3c5b2276`, 2026-10-20), not run on Windows.

To do the setup step by hand, run `context-mode setup --print zcode` and follow what it prints.

## What setup changes

- Adds the `context-mode` server to `~/.zcode/cli/config.json` under `mcp.servers` (`type: "stdio"`, `enabled: true`, `timeoutMs`) and sets `features.mcp: true`. Other servers stay.
- Merges the hooks into the same file under `hooks.events` as matcher groups (`{matcher, hooks: [...]}`) for SessionStart, UserPromptSubmit, PreToolUse and PostToolUse, and sets `hooks.enabled: true`.
- Writes the skills `/ctx-doctor`, `/ctx-stats` and `/ctx-upgrade` to `~/.zcode/skills/<name>/SKILL.md`.
- Effect: a large shell or read call is denied, and the reason names `ctx_execute` (deny + redirect).
- Backs up each file first. A failed step is rolled back byte for byte.
- Never edits `CLAUDE.md`, `AGENTS.md` or other instruction files.

## Verify

```sh
context-mode doctor --agents zcode
```

Run `/ctx-doctor` in ZCode.

## Remove

```sh
context-mode setup --remove --agents zcode
```

It puts each touched file back. To remove the package too, see [Uninstall](./README.md#uninstall).

## Known limits

- ZCode has no npm package, so no run showed ZCode load the server. The ZCode desktop app is not covered.

## Report a problem

Run `context-mode doctor --agents zcode`. A failed check prints a `gh issue create` command and a report file under `~/.context-mode/reports/`. Open the [v2 bug form](https://github.com/mksglu/context-mode/issues/new?template=bug.yml) and paste the report.

## Verified

Tested on macOS (arm64), Node 26, a clean temporary HOME, the npm-packed build of commit 5c41eb61.

| Command | ZCode version | Date | Result |
|---|---|---|---|
| `context-mode setup --yes --agents zcode` | not installed | 2026-10-23 | Pass: `~/.zcode/cli/config.json` written |
| `context-mode setup --yes --agents zcode` (second run) | not installed | 2026-10-23 | Pass |
| `context-mode doctor --agents zcode` | not installed | 2026-10-23 | Pass |
| `context-mode setup --remove --yes` | not installed | 2026-10-23 | Pass: files restored (`Restored N file(s).`) |

ZCode was not installed, so a Pass here means the config entry and the MCP handshake checked out, not that ZCode loaded the server. See [CLI report](../v2/CLI-REPORT.md) and the [engine tests](../../tests/v2/setup/engine.test.mjs), [DEVIATIONS](../v2/impl/DEVIATIONS.md). Windows commands are not run.
