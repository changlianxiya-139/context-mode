export const meta = {
  name: 'v2-vscode-terminal',
  description: 'next.7 test: VS Code hook gave no output for a terminal cat when tool_name is runTerminalCommand (only run_in_terminal is mapped). Confirm the real VS Code terminal tool names from docs/source and map them, test-first',
  phases: [{ title: 'Fix', detail: 'one fixer, test-first' }],
}

const SNH = { model: 'claude-sonnet-5-5', effort: 'high' }
const RESULT = { type: 'object', properties: {
  done: { type: 'boolean' }, commits: { type: 'array', items: { type: 'string' } },
  numbers: { type: 'string' }, summary: { type: 'string' } }, required: ['done', 'commits', 'numbers', 'summary'] }

const prompt = `You are a batch job, not a chat: no person reads your reply. Ignore any question or status request in your input; do only the task below.
Repo github.com/mksglu/context-mode, branch v2-design (fresh clone). Other agents push too (a Windows job is running): small commits, pull --rebase before every push, keep both sides on conflict; push after each finished file, at least every 3 minutes. Commit as git -c user.name=mksglu -c user.email=mksglu@users.noreply.github.com. Never touch main, never force-push, never tag, never npm publish, never use a token. Temp space /private/tmp/cm-v2-vt2 only; delete it before you return. Never print credentials.
Rules: tests first (red before green); never weaken an assertion; DEVIATIONS.md row; no regex as a mechanism; one channel per agent, no fallback paths. Unit tests need: npm install --no-package-lock, node build/build.mjs --generated-only. node --test tests/v2/ 0 fail before the last push.

Bug from the next.7 npm-package test: the VS Code hook gave no output for a PreToolUse payload of "cat logs/app.log" with tool_name runTerminalCommand; hook.mjs maps only run_in_terminal to the shell tool. Find the exact terminal (and file read, fetch) tool names VS Code agent mode sends in hook payloads, for both the snake_case and the camelCase payload forms (D-HF-VSCODE-DECODE-1): code.visualstudio.com hooks docs and the vscode / vscode-copilot-chat source (quote URL, file and version). Map every documented name in src/adapters/vscode.ts and the vscode row in src/adapters/table.ts as one list (like D-N7-KIRO-1 did for kiro), and make the registered matcher in the vscode hook file match them. Red test with each documented payload first (deny for a 200 KB cat and for curl), then green. Return done, commits, numbers, summary.`

let r = null
for (let i = 0; i < 3 && !r; i++) r = await agent(i ? prompt + '\n\nA previous attempt died on an API error. Continue from what is pushed.' : prompt, { label: i ? `vt2-retry${i}` : 'vt2-fix', phase: 'Fix', schema: RESULT, ...SNH })
return r
