// impl/10 §7 + shared decode/encode pseudocode; ADR-0016 VS Code row (case C: no replace channel).
// VS Code hooks send the Claude-style snake_case payload; tool names are mcp_<server>_<tool> (TECH-SPEC §3.8).
// PreCompact is the aux event that sets the pending flag (ADR-0009 §6, impl/09 §4.7, DEVIATIONS D-M3-A4-1).
import type { CanonicalEventName, AuxEventName, CanonicalHookEvent, Decision, HookOutput, ToolResultInfo } from "../core/contracts/types.ts";
import { encodeClaudeShape } from "./claude-code.ts";

export const TOOL_NAME_PREFIX = "mcp_context-mode_"; // impl/10 §1.3, TECH-SPEC §3.8 VS Code row

const VSCODE_EVENTS: readonly (CanonicalEventName | AuxEventName)[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact"];
const MCP_PREFIX = "mcp_";
const MCP_SEP = "_";
const SESSION_START_NEW = "new"; // impl/10 §7: SessionStart fires only with source "new" (first turn)

// Own tool -> bare ctx_*; mcp_<server>_<tool> -> "mcp:<server>:<tool>", split at the first "_" after "mcp_"
// (DEVIATIONS D-M3-A4-3); native names unchanged.
// D-HF-VSCODE-PROJECT-1: the VS Code agent terminal tool is run_in_terminal; it is the shell tool (Bash).
export const SHELL_TOOL_NAME = "run_in_terminal";
const NATIVE_TO_CANONICAL: Readonly<Record<string, string>> = { [SHELL_TOOL_NAME]: "Bash" };

function canonicalName(name: string): string {
  if (name.startsWith(TOOL_NAME_PREFIX)) return name.slice(TOOL_NAME_PREFIX.length);
  if (Object.hasOwn(NATIVE_TO_CANONICAL, name)) return NATIVE_TO_CANONICAL[name];
  if (!name.startsWith(MCP_PREFIX)) return name;
  const rest = name.slice(MCP_PREFIX.length);
  const sep = rest.indexOf(MCP_SEP);
  if (sep <= 0 || sep === rest.length - 1) return name;
  return "mcp:" + rest.slice(0, sep) + ":" + rest.slice(sep + MCP_SEP.length);
}

function readResult(resp: unknown): ToolResultInfo {
  const text = resp === undefined ? "" : typeof resp === "string" ? resp : JSON.stringify(resp);
  const isError = typeof resp === "object" && resp !== null && (resp as { is_error?: unknown }).is_error === true;
  return { isError, bytes: Buffer.byteLength(text), text };
}

// D-HF-VSCODE-DECODE-1: two documented payload shapes, one key set each, chosen by the event name's casing.
// snake: Local harness and the PascalCase alias (code.visualstudio.com/docs/agents/reference/hooks-reference,
// "Common input"): hook_event_name, session_id, tool_name, tool_input, tool_response. camel: Copilot harness
// camelCase events (docs.github.com/en/copilot/reference/hooks-reference): sessionId, toolName, toolArgs,
// toolResult {resultType, textResultForLlm}; the documented payload names no event, a live next.6 payload
// carried hookEventName. No cross-reading of keys between the two.
const CAMEL_EVENTS: Readonly<Record<string, CanonicalEventName | AuxEventName>> = {
  sessionStart: "SessionStart", userPromptSubmitted: "UserPromptSubmit", preToolUse: "PreToolUse", postToolUse: "PostToolUse", preCompact: "PreCompact",
};
// A camelCase payload with no event name: each event has its own key (GitHub hooks reference payload types).
const EVENT_BY_KEY: readonly (readonly [string, string])[] = [
  ["toolResult", "postToolUse"], ["toolName", "preToolUse"], ["prompt", "userPromptSubmitted"], ["source", "sessionStart"], ["trigger", "preCompact"],
];
const SESSION_SOURCES: Readonly<Record<string, NonNullable<CanonicalHookEvent["source"]>>> = { new: "startup", startup: "startup", resume: "resume" };
const RESULT_SUCCESS = "success";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// toolArgs arrives as an object or as a JSON-encoded string; anything else is {} (same rule as copilot-cli).
function readArgs(v: unknown): Record<string, unknown> {
  if (isRecord(v)) return v;
  if (typeof v !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(v);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readCamelResult(v: unknown): ToolResultInfo {
  const r = isRecord(v) ? v : {};
  const text = typeof r.textResultForLlm === "string" ? r.textResultForLlm : "";
  return { isError: typeof r.resultType === "string" && r.resultType !== RESULT_SUCCESS, bytes: Buffer.byteLength(text), text };
}

function decodeCamel(p: Record<string, unknown>, name: unknown): CanonicalHookEvent {
  const event = typeof name === "string" ? CAMEL_EVENTS[name] ?? VSCODE_EVENTS.find((e) => e === name) : undefined;
  if (event === undefined) throw new Error("vscode: unknown hook event " + String(name));
  const ev: CanonicalHookEvent = { event, agent: "vscode", sessionId: String(p.sessionId ?? ""), cwd: String(p.cwd ?? "") };
  if (event === "SessionStart" && typeof p.source === "string" && SESSION_SOURCES[p.source] !== undefined) ev.source = SESSION_SOURCES[p.source];
  if (event === "UserPromptSubmit" && typeof p.prompt === "string") ev.prompt = p.prompt;
  if (event === "PreToolUse" || event === "PostToolUse") {
    const toolName = String(p.toolName ?? "");
    ev.tool = { name: toolName, canonicalName: canonicalName(toolName), input: readArgs(p.toolArgs) };
  }
  if (event === "PostToolUse") ev.result = readCamelResult(p.toolResult);
  return ev;
}

export function decode(raw: unknown): CanonicalHookEvent {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("vscode: hook payload is not a JSON object");
  const p = raw as Record<string, unknown>;
  if (p.hookEventName !== undefined) return decodeCamel(p, p.hookEventName);
  if (p.hook_event_name === undefined) {
    const byKey = EVENT_BY_KEY.find(([key]) => Object.hasOwn(p, key))?.[1];
    if (byKey === undefined) throw new Error("vscode: missing required field hook_event_name"); // never a silent drop
    return decodeCamel(p, byKey);
  }
  const event = VSCODE_EVENTS.find((e) => e === p.hook_event_name);
  if (event === undefined) throw new Error("vscode: unknown hook event " + String(p.hook_event_name));
  // session_id optional. cwd is the common input field (VS Code hooks reference, "Common input"); it is the
  // hook's one project channel (D-HF-VSCODE-PROJECT-1); the server's is --workspace-folder. No subagent field.
  const ev: CanonicalHookEvent = { event, agent: "vscode", sessionId: String(p.session_id ?? ""), cwd: String(p.cwd ?? "") };
  if (event === "SessionStart" && p.source === SESSION_START_NEW) ev.source = "startup"; // DEVIATIONS D-M3-A4-2
  if (event === "UserPromptSubmit" && typeof p.prompt === "string") ev.prompt = p.prompt;
  if (event === "PreToolUse" || event === "PostToolUse") {
    const name = String(p.tool_name ?? "");
    const input = isRecord(p.tool_input) ? p.tool_input : {};
    ev.tool = { name, canonicalName: canonicalName(name), input };
  }
  if (event === "PostToolUse") ev.result = readResult(p.tool_response);
  return ev;
}

// hint -> additionalContext; deny -> permissionDecision "deny" + reason (rewrite first, ADR-0016 case B);
// replace -> silent no-op, VS Code has no output-replace field (ADR-0016 case C, impl/10 §7).
export function encode(ev: CanonicalHookEvent, d: Decision, _extra?: string): HookOutput {
  return encodeClaudeShape(ev, d, false);
}
