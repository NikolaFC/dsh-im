import { t } from './i18n.mjs';

// Thinking-trace display rules. Truncation fallback (spoiler / inline-button
// expansion are follow-ups gated on three-platform client verification):
// tool traces cap the argument summary, reasoning caps the first paragraph.
const TOOL_TRACE_ARG_KEYS = Object.freeze([
  'command', 'pattern', 'query', 'url', 'file_path', 'path', 'text', 'prompt', 'message', 'description',
]);
const TOOL_TRACE_SUMMARY_LIMIT = 120;
const THINKING_LINE_LIMIT = 200;

function truncateCapped(value, limit) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** Extract a one-line argument summary from a tool call's `arguments`. */
export function toolTraceSummary(argumentsValue) {
  let record = null;
  if (argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) {
    record = argumentsValue;
  } else if (typeof argumentsValue === 'string') {
    const trimmed = argumentsValue.trim();
    if (!trimmed) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return truncateCapped(trimmed.replace(/\s+/g, ' ').trim(), TOOL_TRACE_SUMMARY_LIMIT);
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      record = parsed;
    } else {
      return truncateCapped(trimmed.replace(/\s+/g, ' ').trim(), TOOL_TRACE_SUMMARY_LIMIT);
    }
  }
  if (!record) return null;
  for (const key of TOOL_TRACE_ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return truncateCapped(value.replace(/\s+/g, ' ').trim(), TOOL_TRACE_SUMMARY_LIMIT);
    }
  }
  return null;
}

/** Format one tool-trace line: `🔧 <name> → <summary>` (summary optional). */
export function formatToolTrace(name, argumentsValue) {
  const toolName = typeof name === 'string' && name.trim() ? name.trim() : t('工具');
  const summary = toolTraceSummary(argumentsValue);
  return summary ? `🔧 ${toolName} → ${summary}` : `🔧 ${toolName}`;
}

/** Format one reasoning line: `💭 <first paragraph>` (200-char cap). */
export function formatThinkingLine(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return null;
  const firstParagraph = trimmed.split(/\n{2,}/)[0].trim();
  if (!firstParagraph) return null;
  return `💭 ${truncateCapped(firstParagraph, THINKING_LINE_LIMIT)}`;
}
