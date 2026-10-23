import React, { useMemo, useRef, useState } from 'react';
import fs from 'node:fs';
import { Box, Text, useInput } from 'ink';
import type { PermissionAnswer, PlanAnswer } from '../agent.js';
import { applyEdit, makeDiff } from '../tools/files.js';
import type { Tool } from '../tools/index.js';
import { displayPath, isInsideDir, resolvePath } from '../tools/types.js';
import { renderDiff, renderMarkdown } from './markdown.js';
import { sanitize, sanitizeStrict } from './sanitize.js';
import { gitHooks, riskyGitConfig } from '../tools/git.js';
import { C } from './theme.js';

/** Lines the prompt chrome takes besides its content: border, title, spacing, question and 3 options. */
const CHROME_LINES = 9;

/** Diff of what a Write/Edit would do, computed before running it, at most maxLines long. */
function previewDiff(tool: Tool, input: any, cwd: string, maxLines: number): string | null {
  try {
    const abs = resolvePath({ cwd }, input.file_path);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    let after: string;
    if (tool.name === 'Write') after = String(input.content ?? '');
    else if (tool.name === 'Edit') {
      const edit = applyEdit(before, input);
      if ('error' in edit) return null;
      after = edit.after;
    } else return null;
    const patch = makeDiff(displayPath({ cwd }, abs), before, after);
    return patch ? renderDiff(patch, maxLines, sanitizeStrict) : `(large change: ${before.split('\n').length} → ${after.split('\n').length} lines)`;
  } catch {
    return null;
  }
}

/** Clips text to a number of lines, saying how many were left out. */
function clip(text: string, max: number): string {
  const lines = text.split('\n');
  return lines.length <= max ? text : [...lines.slice(0, Math.max(1, max - 1)), `… +${lines.length - Math.max(1, max - 1)} more lines`].join('\n');
}

/**
 * Keys typed while a prompt pops up were meant for the input box, not for the prompt: ignore keys
 * until the keyboard has been quiet for a moment after the prompt appeared. Once a key gets
 * through, every later key counts, however fast it comes.
 */
function useArmed(quietMs = 450) {
  const shownAt = useRef(Date.now());
  const lastKey = useRef(0);
  const armed = useRef(false);
  return () => {
    if (armed.current) return true;
    const now = Date.now();
    armed.current = now - Math.max(shownAt.current, lastKey.current) >= quietMs;
    lastKey.current = now;
    return armed.current;
  };
}

export function PermissionPrompt({
  tool,
  input,
  cwd,
  rules = [],
  maxLines = 30,
  onAnswer,
}: {
  tool: Tool;
  input: any;
  cwd: string;
  /** What "don't ask again" would store; empty means this call can only be allowed once. */
  rules?: string[];
  /** Total height budget for the prompt, so it never outgrows the terminal. */
  maxLines?: number;
  onAnswer: (a: PermissionAnswer) => void;
}) {
  const [sel, setSel] = useState(0);
  const armed = useArmed();
  const budget = Math.max(3, maxLines - CHROME_LINES);
  const diff = useMemo(() => previewDiff(tool, input, cwd, Math.max(2, budget - 1)), [tool, input, cwd, budget]);
  const command = sanitizeStrict(String(input.command ?? ''));
  // A project can come with git hooks or config that run programs on commit, checkout and the like.
  const gitWarning = useMemo(() => {
    if (tool.name !== 'Bash' || !/(^|[;&|(]\s*)git(\s|$)/m.test(String(input.command ?? ''))) return '';
    const hooks = gitHooks(cwd);
    const config = (riskyGitConfig(cwd) ?? []).filter(k => k !== 'submodules');
    const parts = [
      hooks.length ? `its git hooks (${hooks.slice(0, 4).join(', ')}) run too` : '',
      config.length ? `its git config can run programs (${config.slice(0, 3).join(', ')})` : '',
    ].filter(Boolean);
    return parts.length ? sanitizeStrict(`This repository is set up so that ${parts.join(', and ')}.`) : '';
  }, [tool, input, cwd]);
  // "Don't ask again" is only offered when the agent would store a rule for it, and its label
  // says what that rule covers: Bash(git commit) covers plain `git commit` commands (see bashRule).
  const ruleLabel = (rule: string) => {
    const m = rule.match(/^(\w+)\((.*)\)$/);
    if (tool.name === 'Bash' && m) return `\`${sanitize(m[2])}\` commands`;
    if (tool.name === 'WebFetch' && m) return sanitize(m[2]);
    return `${tool.name} in this project`;
  };
  const options: { label: string; answer: PermissionAnswer }[] = [
    { label: 'Yes', answer: 'allow' },
    ...(rules.length
      ? [{ label: `Yes, and don't ask again for ${rules.map(ruleLabel).join(', ')} this session`, answer: 'always' as const }]
      : []),
    { label: 'No, and tell Raon what to do differently (esc)', answer: 'deny' },
  ];
  const n = options.length;

  useInput((ch, key) => {
    if (key.escape) return onAnswer('deny');
    if (!armed()) return;
    if (key.upArrow) setSel(s => (s + n - 1) % n);
    else if (key.downArrow || key.tab) setSel(s => (s + 1) % n);
    else if (key.return) onAnswer(options[sel].answer);
    else if (/^[1-9]$/.test(ch) && Number(ch) <= n) onAnswer(options[Number(ch) - 1].answer);
  });

  const title =
    tool.name === 'Bash'
      ? 'Bash command'
      : tool.name === 'Write'
        ? 'Create file'
        : tool.name === 'Edit'
          ? 'Edit file'
          : tool.name === 'WebFetch'
            ? 'Fetch from the web'
            : tool.readOnly
              ? `${tool.name} in a credential folder`
              : tool.name;
  // Read and Edit name a file; LS, Glob and Grep a folder (when they ask, it is a credential folder).
  const target = input.file_path ?? input.path;
  const abs = target ? resolvePath({ cwd }, String(target)) : '';
  const file = abs ? sanitizeStrict(displayPath({ cwd }, abs)) : '';
  const outside = abs && !isInsideDir(cwd, abs);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.gold} paddingX={1}>
      <Text color={C.gold} bold>
        🐾 {title}
      </Text>
      <Box marginY={1} flexDirection="column" paddingLeft={2}>
        {tool.name === 'Bash' ? (
          <>
            <Text color={C.parchment}>{clip(command, budget - (input.description ? 1 : 0) - (gitWarning ? 1 : 0))}</Text>
            {input.description ? <Text color={C.dim} wrap="truncate-end">{sanitizeStrict(String(input.description))}</Text> : null}
            {gitWarning ? <Text color={C.berry}>⚠ {gitWarning}</Text> : null}
          </>
        ) : tool.name === 'WebFetch' ? (
          <Text color={C.sky}>{clip(sanitizeStrict(String(input.url ?? '')), budget)}</Text>
        ) : (
          <>
            <Text color={C.parchment} wrap="truncate-end">
              {file}
              {outside ? <Text color={C.berry}> (outside the project)</Text> : null}
            </Text>
            {tool.name === 'Glob' || tool.name === 'Grep' ? (
              <Text color={C.dim} wrap="truncate-end">
                {sanitizeStrict(String(input.glob ?? input.pattern ?? ''))}
              </Text>
            ) : null}
            {diff ? <Text>{diff}</Text> : null}
          </>
        )}
      </Box>
      <Text color={C.parchment}>Do you want to proceed?</Text>
      {options.map((o, i) => (
        <Text key={i} color={i === sel ? C.gold : C.dim} wrap="truncate-end">
          {i === sel ? '❯ ' : '  '}
          {i + 1}. {o.label}
        </Text>
      ))}
    </Box>
  );
}

/** Shown when Raon finishes planning in plan mode: approve the plan, or keep planning. */
export function PlanApproval({ plan, maxLines = 30, onAnswer }: { plan: string; maxLines?: number; onAnswer: (a: PlanAnswer) => void }) {
  const [sel, setSel] = useState(0);
  const armed = useArmed();
  const options: { label: string; answer: PlanAnswer }[] = [
    { label: 'Yes, and auto-accept edits', answer: 'acceptEdits' },
    { label: 'Yes, and manually approve edits', answer: 'default' },
    { label: 'No, keep planning (esc)', answer: 'keep' },
  ];

  useInput((ch, key) => {
    if (key.escape) return onAnswer('keep');
    if (!armed()) return;
    if (key.upArrow) setSel(s => (s + 2) % 3);
    else if (key.downArrow || key.tab) setSel(s => (s + 1) % 3);
    else if (key.return) onAnswer(options[sel].answer);
    else if (['1', '2', '3'].includes(ch)) onAnswer(options[Number(ch) - 1].answer);
  });

  const rendered = renderMarkdown(sanitize(plan.trim() || '(empty plan)'), (process.stdout.columns || 80) - 6);
  const budget = Math.max(3, maxLines - CHROME_LINES);
  const lines = rendered.split('\n');
  const shown = lines.length <= budget ? rendered : [...lines.slice(0, budget - 1), `… ${lines.length - budget + 1} more lines (the full plan is above ↑)`].join('\n');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.sky} paddingX={1}>
      <Text color={C.sky} bold>
        📜 Raon's plan
      </Text>
      <Box marginY={1} paddingLeft={1}>
        <Text>{shown}</Text>
      </Box>
      <Text color={C.parchment}>Would you like to proceed?</Text>
      {options.map((o, i) => (
        <Text key={i} color={i === sel ? C.gold : C.dim}>
          {i === sel ? '❯ ' : '  '}
          {i + 1}. {o.label}
        </Text>
      ))}
    </Box>
  );
}
