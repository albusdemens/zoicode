import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import { C } from './theme.js';

export interface Suggestion {
  name: string;
  description: string;
}

interface Props {
  active: boolean;
  history: string[];
  suggestions: (value: string) => Suggestion[];
  onSubmit: (value: string) => void;
  /** Called for keys the input does not handle itself (esc, ctrl+c, shift+tab). */
  onKey?: (input: string, key: any, value: string, setValue: (v: string) => void) => boolean;
}

interface EditState {
  value: string;
  cursor: number;
  /** Position in history while browsing with ↑/↓ (-1: not browsing). */
  histIdx: number;
  /** What was typed before browsing started. */
  draft: string;
  selected: number;
  /** The value is an unedited history entry: don't treat it as a command being typed. */
  recalled: boolean;
}

const MAX_SUGGESTIONS = 8;

function modeOf(value: string): { glyph: string; color: string; hint: string } {
  if (value.startsWith('!')) return { glyph: '!', color: C.berry, hint: 'bash mode' };
  if (value.startsWith('#')) return { glyph: '#', color: C.purple, hint: 'memory mode · saved to RAONCODE.md' };
  if (value.startsWith('/')) return { glyph: '›', color: C.sky, hint: '' };
  return { glyph: '›', color: C.gold, hint: '' };
}

export function PromptInput({ active, history, suggestions, onSubmit, onKey }: Props) {
  // Several key events can arrive in one stdin read and are handled before React re-renders,
  // so the editing state lives in a ref that every event reads and writes synchronously.
  const st = useRef<EditState>({ value: '', cursor: 0, histIdx: -1, draft: '', selected: 0, recalled: false });
  const [, rerender] = useState(0);
  const update = (patch: Partial<EditState>) => {
    Object.assign(st.current, patch);
    rerender(n => n + 1);
  };
  const setValue = (value: string, cursor = value.length) =>
    update({ value, cursor: Math.max(0, Math.min(cursor, value.length)), selected: 0, recalled: false });
  const matchesOf = (s: EditState) => (s.value.startsWith('/') && !s.value.includes(' ') && !s.recalled ? suggestions(s.value) : []);
  const recall = (histIdx: number, patch: Partial<EditState> = {}) => {
    const value = history[history.length - 1 - histIdx];
    update({ ...patch, histIdx, value, cursor: value.length, selected: 0, recalled: true });
  };

  useInput(
    (input, key) => {
      const s = st.current;
      if (onKey?.(input, key, s.value, v => setValue(v))) return;
      const matches = matchesOf(s);

      if (key.tab && matches.length) return setValue('/' + matches[s.selected].name + ' ');
      if (key.return) {
        if (s.value.endsWith('\\')) return setValue(s.value.slice(0, -1) + '\n');
        const v = matches.length ? '/' + matches[s.selected].name : s.value;
        if (!v.trim()) return;
        update({ value: '', cursor: 0, histIdx: -1, draft: '', selected: 0, recalled: false });
        onSubmit(v.trim());
        return;
      }
      if (key.upArrow) {
        if (matches.length) return update({ selected: (s.selected - 1 + matches.length) % matches.length });
        if (!history.length) return;
        return recall(Math.min(history.length - 1, s.histIdx + 1), s.histIdx === -1 ? { draft: s.value } : {});
      }
      if (key.downArrow) {
        if (matches.length) return update({ selected: (s.selected + 1) % matches.length });
        if (s.histIdx > 0) return recall(s.histIdx - 1);
        if (s.histIdx === 0) update({ histIdx: -1, value: s.draft, cursor: s.draft.length, recalled: false });
        return;
      }
      if (key.leftArrow) return update({ cursor: Math.max(0, s.cursor - 1) });
      if (key.rightArrow) return update({ cursor: Math.min(s.value.length, s.cursor + 1) });
      if (key.backspace || key.delete) {
        if (s.cursor === 0) return;
        return setValue(s.value.slice(0, s.cursor - 1) + s.value.slice(s.cursor), s.cursor - 1);
      }
      if (key.ctrl) {
        if (input === 'a') return update({ cursor: 0 });
        if (input === 'e') return update({ cursor: s.value.length });
        if (input === 'u') return setValue(s.value.slice(s.cursor), 0);
        if (input === 'k') return setValue(s.value.slice(0, s.cursor), s.cursor);
        if (input === 'w') {
          const before = s.value.slice(0, s.cursor).replace(/\S+\s*$/, '');
          return setValue(before + s.value.slice(s.cursor), before.length);
        }
        return;
      }
      if (key.tab || key.escape || key.meta) return;
      if (input) {
        const text = input.replace(/\r\n?/g, '\n');
        setValue(s.value.slice(0, s.cursor) + text + s.value.slice(s.cursor), s.cursor + text.length);
      }
    },
    { isActive: active },
  );

  const { value, cursor, selected } = st.current;
  const matches = matchesOf(st.current);
  const mode = modeOf(value);
  const at = value[cursor] ?? ' ';
  const shown = active
    ? value.slice(0, cursor) + chalk.inverse(at === '\n' ? ' ' : at) + (at === '\n' ? '\n' : '') + value.slice(cursor + 1)
    : value;
  // Keep the highlighted suggestion visible when there are more than fit.
  const start = Math.max(0, Math.min(selected - MAX_SUGGESTIONS + 1, matches.length - MAX_SUGGESTIONS));
  const visible = matches.slice(start, start + MAX_SUGGESTIONS);

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor={active ? (mode.color === C.gold ? C.woodLight : mode.color) : C.woodDark} paddingX={1}>
        <Text color={mode.color} bold>
          {mode.glyph}{' '}
        </Text>
        <Box flexGrow={1}>
          {value ? (
            <Text>{shown}</Text>
          ) : (
            <Text color={C.dim}>
              {active ? chalk.inverse(' ') : ''}
              {active ? 'Plant a request… (/ for commands, @ to mention files)' : ''}
            </Text>
          )}
        </Box>
      </Box>
      {mode.hint ? (
        <Box paddingX={2}>
          <Text color={mode.color}>{mode.hint}</Text>
        </Box>
      ) : null}
      {visible.length > 0 && (
        <Box flexDirection="column" paddingX={2}>
          {start > 0 ? <Text color={C.dim}>  ↑ {start} more</Text> : null}
          {visible.map((m, i) => (
            <Text key={m.name} color={start + i === selected ? C.gold : C.dim} wrap="truncate-end">
              {start + i === selected ? '❯ ' : '  '}
              {('/' + m.name).padEnd(14)} {m.description}
            </Text>
          ))}
          {start + MAX_SUGGESTIONS < matches.length ? <Text color={C.dim}>  ↓ {matches.length - start - MAX_SUGGESTIONS} more</Text> : null}
        </Box>
      )}
    </Box>
  );
}
