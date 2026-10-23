import React from 'react';
import path from 'node:path';
import { Box, Text } from 'ink';
import type { ToolResult } from '../tools/index.js';
import type { Todo } from '../tools/todo.js';
import { bulleted, renderDiff, renderMarkdown } from './markdown.js';
import { sanitize } from './sanitize.js';
import { C, paint } from './theme.js';

export type Item =
  | { kind: 'banner'; id: string; lines: string[] }
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'plan'; id: string; text: string }
  | { kind: 'thought'; id: string; seconds: number; text: string }
  | { kind: 'tool'; id: string; name: string; label: string; status: 'running' | 'done' | 'error' | 'denied'; result?: ToolResult; input?: any; progress?: string }
  | { kind: 'todos'; id: string; todos: Todo[] }
  | { kind: 'bash'; id: string; command: string; output: string; isError: boolean }
  | { kind: 'info'; id: string; text: string; color?: string };

const TOOL_ICONS: Record<string, string> = {
  Read: '📖', Write: '📝', Edit: '✎', Bash: '⚡', Glob: '🔍', Grep: '🔍', LS: '🗂', TodoWrite: '📜', WebFetch: '🌐', Task: '🧶', ExitPlanMode: '📜',
};

function shortLabel(label: string, cwd: string): string {
  // A tool header is one line: multi-line commands show their first line and an ellipsis.
  const lines = sanitize(label).split('\n');
  label = lines[0] + (lines.length > 1 ? ' …' : '');
  if (path.isAbsolute(label)) {
    const rel = path.relative(cwd, label);
    if (!rel.startsWith('..')) return rel || '.';
  }
  return label.length > 120 ? label.slice(0, 117) + '…' : label;
}

const columns = () => process.stdout.columns || 80;

/** "⎿  " followed by a block whose continuation lines stay indented. */
function Result({ children, color }: { children: string; color: string }) {
  return (
    <Box paddingLeft={2}>
      <Text color={color}>{bulleted(children, paint.dim('⎿  '), columns() - 2)}</Text>
    </Box>
  );
}

function preview(output: string, lines = 4): string {
  const all = sanitize(output).replace(/\n+Exit code 0$/, '').split('\n');
  const shown = all.slice(0, lines).map(l => (l.length > 160 ? l.slice(0, 157) + '…' : l));
  return shown.join('\n') + (all.length > lines ? `\n… +${all.length - lines} lines` : '');
}

export function TodoList({ todos, max = 12 }: { todos: Todo[]; max?: number }) {
  // When the list is longer than fits, show the item in progress and its neighbors.
  const current = Math.max(0, todos.findIndex(t => t.status !== 'completed'));
  const start = Math.max(0, Math.min(current - 2, todos.length - max));
  const shown = todos.slice(start, start + max);
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color={C.gold} bold>
        📜 To-do list
      </Text>
      {start > 0 ? <Text color={C.dim}>  … {start} done above</Text> : null}
      {shown.map((t, i) => (
        <Text
          key={start + i}
          color={t.status === 'completed' ? C.grass : t.status === 'in_progress' ? C.gold : C.parchment}
          strikethrough={t.status === 'completed'}
          bold={t.status === 'in_progress'}
          wrap="truncate-end"
        >
          {'  '}
          {t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐'} {sanitize(String(t.content))}
        </Text>
      ))}
      {start + max < todos.length ? <Text color={C.dim}>  … {todos.length - start - max} more</Text> : null}
    </Box>
  );
}

export function ToolLine({ item, cwd }: { item: Extract<Item, { kind: 'tool' }>; cwd: string }) {
  const dot =
    item.status === 'running' ? C.gold : item.status === 'done' ? C.grass : item.status === 'denied' ? C.stone : C.berry;
  const r = item.result;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text wrap="truncate-end">
        <Text color={dot}>⏺ </Text>
        <Text bold color={C.parchment}>
          {item.name}
        </Text>
        <Text color={C.dim}>({shortLabel(item.label, cwd)})</Text>
      </Text>
      {item.status === 'running' ? (
        <Text color={C.dim} wrap="truncate-end">
          {'  ⎿  '}
          {TOOL_ICONS[item.name] ?? '⚙'} {item.progress ? sanitize(item.progress) : 'working…'}
        </Text>
      ) : item.status === 'denied' ? (
        <Text color={C.stone}>  ⎿  Denied</Text>
      ) : r?.isError ? (
        <Result color={C.berry}>{preview(r.output, 6)}</Result>
      ) : (
        <Box flexDirection="column" paddingLeft={2}>
          <Text color={C.dim} wrap="truncate-end">
            ⎿  {r?.summary ? sanitize(r.summary) : preview(r?.output ?? '', 1)}
          </Text>
          {r?.diff ? (
            <Box paddingLeft={3}>
              <Text>{renderDiff(r.diff)}</Text>
            </Box>
          ) : item.name === 'Bash' && r?.output ? (
            <Box paddingLeft={3}>
              <Text color={C.stone}>{preview(r.output)}</Text>
            </Box>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

export function MessageItem({ item, cwd }: { item: Item; cwd: string }) {
  switch (item.kind) {
    case 'banner':
      return <Text>{item.lines.join('\n')}</Text>;
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={C.dim}>
            <Text color={C.gold}>› </Text>
            {sanitize(item.text)}
          </Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Text>{bulleted(renderMarkdown(sanitize(item.text), columns() - 2), paint.grass('⏺ '), columns())}</Text>
        </Box>
      );
    case 'plan':
      return (
        <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={C.sky} paddingX={1}>
          <Text color={C.sky} bold>
            📜 Raon's plan
          </Text>
          <Text>{bulleted(renderMarkdown(sanitize(item.text), columns() - 6), '', columns() - 4)}</Text>
        </Box>
      );
    case 'thought':
      return (
        <Box marginTop={1}>
          <Text color={C.dim} italic>
            ✻ Thought for {item.seconds}s
          </Text>
        </Box>
      );
    case 'tool':
      return <ToolLine item={item} cwd={cwd} />;
    case 'todos':
      return (
        <Box marginTop={1}>
          <TodoList todos={item.todos} />
        </Box>
      );
    case 'bash':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={C.berry} bold>! </Text>
            <Text color={C.parchment}>{sanitize(item.command)}</Text>
          </Text>
          <Result color={item.isError ? C.berry : C.stone}>{preview(item.output, 12)}</Result>
        </Box>
      );
    case 'info':
      return (
        <Box marginTop={1} paddingLeft={2}>
          <Text color={item.color ?? C.dim}>{item.text}</Text>
        </Box>
      );
    default:
      return null;
  }
}
