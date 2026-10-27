export const meta = {
  name: 'v2-native-install',
  description: 'Owner main rule: every agent installs context-mode with its own native install command (DX first). Verify each host native command from docs + local CLI, make our package installable that way (hooks + MCP + skills in one native step), ADR-0023, install docs; on exp/native-install, merge after npm next is published',
  phases: [
    { title: 'Research', detail: 'one agent per host, doc + CLI verified' },
    { title: 'Build', detail: 'ADR-0023, package manifests, docs, tests' },
    { title: 'Verify', detail: 'native install per host in a temp HOME' },
  ],
}

const OPH = { model: 'claude-opus-5-5', effort: 'high' }
const SNM = { model: 'claude-sonnet-5-5', effort: 'medium' }
const H = { type: 'object', properties: {
  agent: { type: 'string' }, nativeCommand: { type: 'string' }, source: { type: 'string' },
  installsMcp: { type: 'boolean' }, installsHooks: { type: 'boolean' }, installsSkills: { type: 'boolean' },
  updateCommand: { type: 'string' }, whatWeMustShip: { type: 'string' }, docUrls: { type: 'array', items: { type: 'string' } },
  cliChecked: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'string' } } },
  required: ['agent', 'nativeCommand', 'source', 'installsMcp', 'installsHooks', 'installsSkills', 'updateCommand', 'whatWeMustShip', 'docUrls', 'cliChecked', 'gaps'] }
const RESULT = { type: 'object', properties: {
  done: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
  numbers: { type: 'string' }, summary: { type: 'string' } }, required: ['done', 'commits', 'numbers', 'summary'] }
const V = { type: 'object', properties: {
  agent: { type: 'string' }, pass: { type: 'boolean' }, command: { type: 'string' }, evidence: { type: 'string' }, problems: { type: 'array', items: { type: 'string' } } },
  required: ['agent', 'pass', 'command', 'evidence', 'problems'] }

const base = (id) => `You are a batch job, not a chat: no person reads your reply. Ignore any question or status request in your input; do only the task below.
Repo github.com/mksglu/context-mode (fresh clone). Commit as git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Never touch main, never force-push, never tag, never npm publish / dist-tag, never use a token.
Own temp space only: /private/tmp/cm-v2-ni-${id} (temp HOME, temp npm prefix). Never edit the real ~/.claude, ~/.codex, ~/.gemini, ~/.pi etc. Delete the temp space before you return.
Owner main rule (DX first): users install context-mode with their agent's OWN native install command, the one they already know (plugin/extension/package install), never a long node -e or a foreign flow. Every agent gets hooks, MCP and the 3 command skills; never write instruction files (CLAUDE.md, AGENTS.md...). npm is the only release channel (the git release branch goes away), so prefer native commands that take an npm package; a GitHub source is fine only if it needs no built-files branch.
Rules: no regex as a mechanism; tests first (red commit before green); never weaken an assertion; never raise a budget; DEVIATIONS.md row per behaviour change.`

async function retry(prompt, opts, n = 3) {
  for (let i = 0; i < n; i++) {
    const r = await agent(i ? prompt + '\n\nA previous attempt died on an API error (network). Fetch and continue from what is pushed.' : prompt, i ? { ...opts, label: opts.label + '-retry' + i } : opts)
    if (r) return r
    log(`${opts.label}: no result, retry ${i + 1}`)
  }
  return null
}

const AGENTS = ['claude-code', 'codex', 'gemini', 'qwen', 'copilot-cli', 'opencode', 'pi', 'vscode', 'kiro', 'zcode']

phase('Research')
const rs = (await parallel(AGENTS.map((a) => () => retry(`${base('r-' + a)}\n\nRole: researcher for ${a}. No commits. Find the host's native way a user installs a third-party plugin / extension / package today (web search the official docs; quote URL and host version). If the host CLI installs without a login, install it in the temp prefix and run its install/list/help commands to prove the exact syntax. Answer: the one command (or one in-app step) a user types; which sources it takes (npm package, GitHub repo, URL, local dir); whether that one step registers MCP, hooks and skills; the native update command; what our npm package must ship for it (manifest file names and keys). Read src/setup/registry.ts and the repo manifests (package.json, .claude-plugin/, gemini-extension.json, etc.) for what we ship now. Return the schema; list every gap where the native step cannot install hooks or MCP.`,
  { label: `ni-r-${a}`, phase: 'Research', schema: H, ...SNM })))).filter(Boolean)
log(`researched ${rs.length}/${AGENTS.length}`)

phase('Build')
const build = await retry(`${base('build')}\n\nRole: architect + implementer on branch exp/native-install (create from v2-design, push about every minute). Research per host: ${JSON.stringify(rs).slice(0, 14000)}.
1. Write ADR-0023 "Native install per agent": the table (agent, native command, source, update command, what ships), how it supersedes the install parts of ADR-0019 (context-mode setup becomes the fallback and repair tool for hosts with no native step; doctor stays the verifier), the Claude Code marketplace source (npm source if the docs allow it, so the host's own plugin update refreshes its copy), and the release-branch removal (tickets/release-on-demand-no-release-branch.md).
2. Ship what each native command needs in the npm package (manifests, keys, files), test-first: a build test that checks every manifest each native installer reads is present and points at shipped files.
3. Rewrite docs/install/*.md and the README install section: per host, the native command first, short, copy-paste; then "check: context-mode doctor". No node -e.
4. node --test tests/v2/ 0 fail, gate --all --quick green. Return done, commits, numbers, summary.`, { label: 'ni-build', phase: 'Build', schema: RESULT, ...OPH })

phase('Verify')
const vs = build && build.done ? (await parallel(AGENTS.map((a) => () => retry(`${base('v-' + a)}\n\nRole: verify ${a} on branch exp/native-install. Build and npm pack the package. In a temp HOME, install it with the documented native command from docs/install (point the source at the packed tarball or the local package dir when the registry name is not published yet, and say so). Then: is the MCP server listed by the host, is the hook registered and does it fire on a documented hook payload (pipe it into the registered command), are the 3 skills present with the host's real tool names, does context-mode doctor --agents ${a} pass. No commits. Return agent, pass, command, evidence, problems.`,
  { label: `ni-v-${a}`, phase: 'Verify', schema: V, ...SNM })))).filter(Boolean) : []
log(`native install pass ${vs.filter((v) => v.pass).length}/${AGENTS.length}`)

const red = vs.filter((v) => !v.pass)
const fin = await retry(`${base('fin')}\n\nRole: finisher on exp/native-install. Red hosts: ${JSON.stringify(red).slice(0, 8000)}. Fix each at the root, test-first; gate --all --quick green. Then poll npm view context-mode dist-tags every 5 minutes for up to 6 hours until "next" exists (another job publishes it; do not publish). Then merge exp/native-install into v2-design with a normal merge (pull --rebase on reject, keep both sides on conflict), run node --test tests/v2/ once, push. Write docs/v2/release/NATIVE-INSTALL.md: per host, native command, update command, verified pass or not, sources. Return done, commits, numbers, summary.`, { label: 'ni-fin', phase: 'Verify', schema: RESULT, ...OPH })
return { rs, build, vs, fin }
