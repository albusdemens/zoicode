import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { Box, Static, Text, useApp, useInput, useStdout, type DOMElement } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { Agent, type PermissionAnswer, type PermissionMode, type PlanAnswer } from '../agent.js';
import type { ChatMessage } from '../llm.js';
import { BashTool } from '../tools/bash.js';
import { findTool, type Tool } from '../tools/index.js';
import type { Todo } from '../tools/todo.js';
import { loadSession, saveSession, type Session } from '../sessions.js';
import { Bubble, CAT_LINES, CatCompanion, pickLine } from './Cat.js';
import type { CatMood } from './catAnim.js';
import { COMMANDS, expandMentions, findCommand, loadCustomCommands, runsWhileBusy, suggestCommands, type CommandApi } from './commands.js';
import { bulleted, renderMarkdown } from './markdown.js';
import { MessageItem, TodoList, ToolLine, type Item } from './Messages.js';
import { PermissionPrompt, PlanApproval } from './Permission.js';
import { menuWindow, PromptInput, SuggestionMenu, type InputStatus } from './PromptInput.js';
import { pinToBottom, type Pin } from './pinBottom.js';
import { sanitize } from './sanitize.js';
import { PET_MARGIN, PET_ROWS } from './scene.js';
import { CAT_W } from './sprites/index.js';
import { C, paint, SPINNER_FRAMES, SPINNER_VERBS } from './theme.js';

let nextId = 0;
const uid = () => String(++nextId);

/** Height of the input box (borders included). */
const PROMPT_ROWS_UI = 3;

const MODE_LABEL: Record<PermissionMode, { text: string; color: string }> = {
  default: { text: '', color: C.dim },
  acceptEdits: { text: '⏵⏵ auto-accept edits on', color: C.purple },
  plan: { text: '⏸ plan mode on', color: C.sky },
  bypass: { text: '⚠ bypass permissions on: nothing asks first', color: C.berry },
};

/** Something that runs one at a time: a turn, a `!` command, or a slash command that changes state. */
type Job =
  | { kind: 'prompt'; prompt: string; display: string; echoed?: boolean }
  | { kind: 'bash'; command: string; display: string }
  | { kind: 'command'; raw: string; display: string };

/** Rebuild display items from saved messages when resuming. */
function itemsFromMessages(messages: ChatMessage[]): Item[] {
  const items: Item[] = [];
  const pending = new Map<string, Extract<Item, { kind: 'tool' }>>();
  for (const m of messages) {
    if (m.role === 'user' && typeof m.content === 'string') {
      items.push({ kind: 'user', id: uid(), text: m.content.split('\n\nAttached files:\n')[0].replace(/\n\n<system-reminder>[\s\S]*$/, '') });
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content.trim()) items.push({ kind: 'assistant', id: uid(), text: m.content });
      for (const c of m.tool_calls ?? []) {
        if (!('function' in c)) continue;
        let input: any = {};
        try { input = JSON.parse(c.function.arguments); } catch { /* ignore */ }
        const tool = findTool(c.function.name);
        const item: Extract<Item, { kind: 'tool' }> = {
          kind: 'tool', id: uid(), name: c.function.name, label: tool ? safe(() => tool.label(input)) : '', status: 'done', input,
        };
        pending.set(c.id, item);
        items.push(item);
      }
    } else if (m.role === 'tool') {
      const item = pending.get(m.tool_call_id);
      if (item) item.result = { output: String(m.content), summary: String(m.content).split('\n')[0].slice(0, 100) };
    }
  }
  return items;
}

function safe(f: () => unknown): string {
  try {
    const v = f();
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/** How full the context window is: a small meter that turns from green to red as it fills. */
function ContextMeter({ used, total }: { used: number; total: number }) {
  const full = Math.min(1, Math.max(0, used / total));
  const n = Math.round(full * 10);
  const color = full < 0.5 ? C.grass : full < 0.8 ? C.gold : C.berry;
  return (
    <Text>
      <Text color={C.dim}>context </Text>
      <Text color={color}>{'▰'.repeat(n)}</Text>
      <Text color={C.woodDark}>{'▱'.repeat(10 - n)}</Text>
    </Text>
  );
}

function Spinner({ frame, verb, started, tokens }: { frame: number; verb: string; started: number; tokens: number }) {
  const secs = Math.floor((Date.now() - started) / 1000);
  const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const colors = [C.grass, C.gold, C.berry, C.gold];
  return (
    <Box marginTop={1}>
      <Text wrap="truncate-end">
        <Text color={colors[Math.floor(frame / SPINNER_FRAMES.length) % colors.length]}>{glyph} </Text>
        <Text color={C.gold}>{verb}… </Text>
        <Text color={C.dim}>
          ({secs}s{tokens ? ` · ↓ ${tokens.toLocaleString()} tokens` : ''} · esc to interrupt)
        </Text>
      </Text>
    </Box>
  );
}

/** The last `max` terminal rows of text wrapped at `width`, with a marker if the start was cut. */
function tail(text: string, width: number, max: number): string {
  const rows = wrapAnsi(text, Math.max(10, width), { hard: true, trim: false }).split('\n');
  if (rows.length <= max) return rows.join('\n');
  return [`… ${rows.length - max + 1} more lines above`, ...rows.slice(-(max - 1))].join('\n');
}

export interface AppProps {
  agent: Agent;
  session: Session;
  initialPrompt?: string;
  /** The banner printed at the top; `makeBanner` redraws it after /clear and friends. */
  banner: string[];
  makeBanner: () => string[];
  /** Say hello when the app opens (fresh sessions). */
  greet?: boolean;
  /** Keeps the caller informed of the current session (for the goodbye message). */
  onSession?: (s: Session) => void;
}

export function App({ agent, session: initialSession, initialPrompt, banner, makeBanner, greet, onSession }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [items, setItems] = useState<Item[]>(() => [
    { kind: 'banner', id: uid(), lines: banner },
    ...itemsFromMessages(initialSession.messages),
    ...(initialSession.messages.length
      ? [{ kind: 'info', id: uid(), text: `↺ Resumed session ${initialSession.id}`, color: C.grass } as Item]
      : []),
  ]);
  const [staticKey, setStaticKey] = useState(0);
  // The first frame is empty, so the live area is pinned before anything is printed (see below).
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [running, setRunning] = useState<Extract<Item, { kind: 'tool' }>[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [permission, setPermission] = useState<{ tool: Tool; input: any; rules: string[]; resolve: (a: PermissionAnswer) => void } | null>(null);
  const [planApproval, setPlanApproval] = useState<{ plan: string; resolve: (a: PlanAnswer) => void } | null>(null);
  const [mode, setMode] = useState<PermissionMode>(agent.permissionMode);
  const [exitArmed, setExitArmed] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [queue, setQueue] = useState<Job[]>([]);
  const [, forceRender] = useState(0);
  const skippedCommands = useRef<string[]>([]);
  const [commands] = useState(() => [...COMMANDS, ...loadCustomCommands(agent.cwd, skippedCommands.current)]);
  const [mood, setMood] = useState<CatMood>('idle');
  const [inputStatus, setInputStatus] = useState<InputStatus>({ matches: [], selected: 0 });
  const [say, setSay] = useState<string | null>(null);
  // Bypass is only reachable with shift+tab if the session started in it (--yolo), like Claude Code.
  const [modes] = useState<PermissionMode[]>(() =>
    agent.permissionMode === 'bypass' ? ['default', 'acceptEdits', 'plan', 'bypass'] : ['default', 'acceptEdits', 'plan'],
  );

  const session = useRef(initialSession);
  const controller = useRef<AbortController | null>(null);
  const live = useRef({ text: '', reasoning: '', started: 0, verb: '', outTokens: 0 });
  /** Set synchronously when a job starts, so input arriving in the same tick is queued, not run. */
  const busyRef = useRef(false);
  /** The running job, so quitting can stop it and wait for it to save. */
  const work = useRef<Promise<unknown> | null>(null);
  const exiting = useRef(false);
  const sayTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const moodTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const exitTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const liveBox = useRef<DOMElement>(null);
  const pin = useRef<Pin | null>(null);

  const push = (...more: Item[]) => setItems(prev => [...prev, ...more]);
  const info = (text: string, color?: string) => push({ kind: 'info', id: uid(), text, color });

  /** Show a speech bubble for a while. */
  const speak = (text: string, ms = 4500) => {
    clearTimeout(sayTimer.current);
    setSay(text);
    sayTimer.current = setTimeout(() => setSay(null), ms);
  };
  /** Switch mood for a while, then settle back to working/idle. */
  const moodFor = (m: CatMood, ms: number) => {
    clearTimeout(moodTimer.current);
    setMood(m);
    moodTimer.current = setTimeout(() => setMood(busyRef.current ? 'working' : 'idle'), ms);
  };
  const track = <T,>(p: Promise<T>): Promise<T> => {
    work.current = p;
    p.finally(() => {
      if (work.current === p) work.current = null;
    }).catch(() => {});
    return p;
  };
  const persist = () => {
    session.current.messages = agent.messages;
    if (agent.messages.length) {
      try { saveSession(session.current); } catch { /* disk full etc. */ }
    }
    onSession?.(session.current);
  };
  /** Clears the screen (and scrollback) and starts over with these items. */
  const resetScreen = (next: Item[]) => {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    pin.current?.refill();
    setStaticKey(k => k + 1);
    setItems([{ kind: 'banner', id: uid(), lines: makeBanner() }, ...next]);
  };

  // Keep the prompt at the bottom of the screen, then show the live area and print the banner, so
  // the first frame Ink writes already fills the screen and the prompt starts at the bottom.
  useLayoutEffect(() => {
    const p = liveBox.current ? pinToBottom(liveBox.current, () => stdout.rows || 24) : null;
    pin.current = p;
    setReady(true);
    return () => p?.release();
  }, []);

  useEffect(() => {
    if (busy) {
      clearTimeout(moodTimer.current);
      setMood('working');
    }
  }, [busy]);

  useEffect(() => {
    if (greet) speak(pickLine(CAT_LINES.greet), 6000);
    if (skippedCommands.current.length) info(`Skipped unreadable custom commands: ${skippedCommands.current.join(', ')}`, C.berry);
    if (initialPrompt) submit(initialPrompt);
    return () => {
      clearTimeout(sayTimer.current);
      clearTimeout(moodTimer.current);
      clearTimeout(exitTimer.current);
    };
  }, []);

  useEffect(() => {
    agent.onPlan = plan =>
      new Promise(resolve => {
        if (exiting.current) return resolve('keep');
        clearTimeout(moodTimer.current);
        setMood('alert');
        speak(pickLine(CAT_LINES.plan), 120_000);
        // The whole plan goes into the scrollback; the approval box shows what fits.
        push({ kind: 'plan', id: uid(), text: plan });
        setPlanApproval({
          plan,
          resolve: a => {
            setPlanApproval(null);
            if (a !== 'keep') setMode(a);
            setMood('working');
            speak(a === 'keep' ? 'Back to the drawing board!' : pickLine(CAT_LINES.allowed), 2500);
            resolve(a);
          },
        });
      });
    agent.onProgress = (id, message) => setRunning(r => r.map(t => (t.id === id ? { ...t, progress: message } : t)));
    agent.canUseTool = (tool, input, rules = []) =>
      new Promise(resolve => {
        if (exiting.current) return resolve('deny');
        clearTimeout(moodTimer.current);
        setMood('alert');
        speak(pickLine(CAT_LINES.permission), 120_000);
        setPermission({
          tool,
          input,
          rules,
          resolve: a => {
            setPermission(null);
            setMood('working');
            speak(pickLine(a === 'deny' ? CAT_LINES.denied : CAT_LINES.allowed), 2500);
            resolve(a);
          },
        });
      });
  }, [agent]);

  // One ticker drives the spinner and throttles streaming re-renders.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setFrame(f => f + 1), 100);
    return () => clearInterval(id);
  }, [busy]);

  // Run queued jobs one at a time once Raon is free.
  useEffect(() => {
    if (busy || busyRef.current || exiting.current || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    runJob(next);
  }, [busy, queue]);

  function startJob(job: Job) {
    if (busyRef.current) setQueue(q => [...q, job]);
    else runJob(job);
  }

  function runJob(job: Job) {
    if (job.kind === 'prompt') track(runTurn(job.prompt, job.display, job.echoed));
    else if (job.kind === 'bash') track(runBang(job.command));
    else track(runCommand(job.raw, true));
  }

  function beginWork(verb: string): AbortController {
    busyRef.current = true;
    setBusy(true);
    const ac = new AbortController();
    controller.current = ac;
    live.current = { text: '', reasoning: '', started: Date.now(), outTokens: 0, verb };
    return ac;
  }

  function endWork() {
    controller.current = null;
    busyRef.current = false;
    setRunning([]);
    setBusy(false);
    persist();
  }

  /** `echoed`: the input line is already on screen (slash commands that submit a prompt). */
  async function runTurn(prompt: string, display: string, echoed = false) {
    if (!echoed) push({ kind: 'user', id: uid(), text: display });
    const ac = beginWork(SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]);
    let thinkStart = 0;
    let thinkEnd = 0;
    const labels = new Map<string, string>();
    let outcome: 'ok' | 'error' | 'interrupted' = 'ok';

    try {
      for await (const ev of agent.run(prompt, ac.signal)) {
        const l = live.current;
        switch (ev.type) {
          case 'reasoning':
            if (!thinkStart) thinkStart = Date.now();
            thinkEnd = Date.now();
            l.reasoning += ev.delta;
            l.outTokens += 1;
            break;
          case 'text':
            l.text += ev.delta;
            l.outTokens += 1;
            break;
          case 'assistant': {
            const out: Item[] = [];
            if (ev.reasoning && thinkStart) {
              out.push({ kind: 'thought', id: uid(), seconds: Math.max(1, Math.round((thinkEnd - thinkStart) / 1000)), text: ev.reasoning });
            }
            if (ev.text.trim()) out.push({ kind: 'assistant', id: uid(), text: ev.text.trim() });
            push(...out);
            l.text = '';
            l.reasoning = '';
            thinkStart = 0;
            break;
          }
          case 'tool_start':
            labels.set(ev.id, ev.label);
            setRunning(r => [...r, { kind: 'tool', id: ev.id, name: ev.name, label: ev.label, status: 'running', input: ev.input }]);
            break;
          case 'tool_end': {
            setRunning(r => r.filter(t => t.id !== ev.id));
            if (ev.name === 'TodoWrite' && !ev.result.isError) {
              const list = (agent.ctx.state.todos as Todo[]) ?? [];
              setTodos(list);
              push({ kind: 'todos', id: uid(), todos: list });
            } else {
              push({
                kind: 'tool', id: uid(), name: ev.name, label: labels.get(ev.id) ?? '',
                status: ev.denied ? 'denied' : ev.result.isError ? 'error' : 'done', result: ev.result,
              });
            }
            break;
          }
          case 'usage':
            break;
          case 'error':
            outcome = 'error';
            info(`✗ ${sanitize(ev.message)}`, C.berry);
            break;
          case 'interrupted':
            outcome = 'interrupted';
            info('⎿  Interrupted · What should Raon do instead?', C.berry);
            break;
        }
      }
    } catch (e) {
      outcome = 'error';
      info(`✗ ${sanitize((e as Error).message)}`, C.berry);
    } finally {
      endWork();
    }
    if (exiting.current) return;

    if (outcome === 'error') {
      moodFor('sad', 5000);
      speak(pickLine(CAT_LINES.error), 5000);
    } else if (outcome === 'interrupted') {
      moodFor('alert', 1500);
      speak(pickLine(CAT_LINES.interrupted), 3000);
    } else {
      moodFor('happy', 3500);
      speak(pickLine(CAT_LINES.done), 5000);
    }

    if (!exiting.current && agent.estimateContextTokens() > agent.llm.config.contextWindow * 0.85) {
      info('The context is almost full: compacting the conversation…', C.gold);
      await doCompact('');
    }
  }

  /** `!command`: runs right away in the shell, like a turn (queued while busy, esc stops it). */
  async function runBang(command: string) {
    const ac = beginWork('Running');
    try {
      const result = await BashTool.run({ command }, { ...agent.ctx, signal: ac.signal });
      push({ kind: 'bash', id: uid(), command, output: result.output, isError: !!result.isError });
      agent.messages.push({
        role: 'user',
        content: `<bash-input>${command}</bash-input>\n<bash-output>${result.output}</bash-output>\n(The user ran this command directly; no reply needed unless asked.)`,
      });
    } catch (e) {
      info(`✗ ${sanitize((e as Error).message)}`, C.berry);
    } finally {
      endWork();
    }
  }

  async function doCompact(instructions: string) {
    const ac = beginWork('Compacting the conversation');
    try {
      const summary = await agent.compact(instructions, ac.signal);
      if (ac.signal.aborted) {
        info('Compaction stopped; the conversation is unchanged.', C.dim);
        return;
      }
      resetScreen([
        { kind: 'info', id: uid(), text: 'Conversation compacted. Summary:', color: C.gold },
        { kind: 'assistant', id: uid(), text: summary || '(empty)' },
      ]);
    } catch (e) {
      info(
        ac.signal.aborted ? 'Compaction stopped; the conversation is unchanged.' : `✗ Compact failed: ${sanitize((e as Error).message)} · the conversation was kept`,
        C.berry,
      );
    } finally {
      endWork();
    }
  }

  /** Stops whatever is running, waits briefly for it to wind down and save, then quits. */
  async function shutdown() {
    if (exiting.current) return;
    exiting.current = true;
    setQueue([]);
    controller.current?.abort();
    permission?.resolve('deny');
    planApproval?.resolve('keep');
    const pending = work.current;
    if (pending) await Promise.race([pending.catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
    persist();
    exit();
  }

  const api: CommandApi = {
    agent,
    info,
    commands,
    clearScreen: () => {
      resetScreen([]);
      setTodos([]);
      session.current = { ...session.current, id: Math.random().toString(16).slice(2, 10), messages: [], title: '' };
      onSession?.(session.current);
    },
    exit: () => void shutdown(),
    pet: () => {
      moodFor('happy', 3000);
      speak(pickLine(CAT_LINES.pet), 3500);
    },
    submit: (prompt, display) => startJob({ kind: 'prompt', prompt, display: display ?? prompt, echoed: true }),
    compact: instructions => track(doCompact(instructions)),
    resume: id => {
      const s = loadSession(agent.cwd, id);
      if (!s) return info(`No session matching "${sanitize(id)}"`, C.berry);
      agent.clear();
      agent.messages = s.messages;
      session.current = s;
      onSession?.(s);
      resetScreen([...itemsFromMessages(s.messages), { kind: 'info', id: uid(), text: `↺ Resumed session ${s.id}`, color: C.grass }]);
    },
  };

  /** Runs a slash command, or queues it if it would change the conversation while Raon is working. */
  async function runCommand(raw: string, queued = false) {
    const [name, ...rest] = raw.slice(1).split(' ');
    const args = rest.join(' ');
    const cmd = findCommand(name, commands);
    if (!cmd) return info(`Unknown command /${sanitize(name)}. Try /help.`, C.berry);
    if (!queued) push({ kind: 'user', id: uid(), text: raw });
    if (busyRef.current && !runsWhileBusy(cmd, args)) {
      setQueue(q => [...q, { kind: 'command', raw, display: raw }]);
      info(`⏳ /${name} will run when Raon is done`, C.dim);
      return;
    }
    try {
      await cmd.run(args, api);
    } catch (e) {
      info(`✗ ${sanitize((e as Error).message)}`, C.berry);
    }
  }

  function submit(raw: string) {
    setHistory(h => (h.at(-1) === raw ? h : [...h, raw]));
    setExitArmed(false);

    if (raw.startsWith('/')) return void runCommand(raw);

    if (raw.startsWith('!')) {
      const command = raw.slice(1).trim();
      if (command) startJob({ kind: 'bash', command, display: raw });
      return;
    }

    if (raw.startsWith('#')) {
      const note = raw.slice(1).trim();
      const file = path.join(agent.cwd, 'ZOICODE.md');
      try {
        const prefix = fs.existsSync(file) ? (fs.readFileSync(file, 'utf8').endsWith('\n') ? '' : '\n') : '# ZOICODE.md\n\n';
        fs.appendFileSync(file, `${prefix}- ${note}\n`);
        agent.refreshSystemPrompt();
        info(`🧠 Remembered in ${path.relative(agent.cwd, file)}: ${note}`, C.purple);
      } catch (e) {
        info(`✗ Could not save the note: ${(e as Error).message}`, C.berry);
      }
      return;
    }

    startJob({ kind: 'prompt', prompt: expandMentions(raw, agent.cwd, agent.ctx.readFiles), display: raw });
  }

  function onKey(input: string, key: any, value: string, setValue: (v: string) => void): boolean {
    if (key.tab && key.shift) {
      const next = modes[(modes.indexOf(mode) + 1) % modes.length] ?? 'default';
      agent.permissionMode = next;
      setMode(next);
      return true;
    }
    if (key.escape) {
      if (busyRef.current) controller.current?.abort();
      else if (value) setValue('');
      return true;
    }
    if (key.ctrl && input === 'c') {
      if (busyRef.current && !exitArmed) {
        controller.current?.abort();
      } else if (value) {
        setValue('');
        return true;
      }
      if (exitArmed) void shutdown();
      else {
        setExitArmed(true);
        clearTimeout(exitTimer.current);
        exitTimer.current = setTimeout(() => setExitArmed(false), 2000);
      }
      return true;
    }
    if (key.ctrl && input === 'l') {
      forceRender(n => n + 1);
      return true;
    }
    return false;
  }

  // ---- layout, sized so the live area always fits on screen -----------------------
  // The pet sits at the bottom right, on top of the prompt box; whatever Raon is doing (its reply,
  // tool calls, the spinner, the pet's speech bubble, the command menu) flows in the column to its
  // left. The live area is pinned to the bottom of the screen (pinBottom.ts).
  const l = live.current;
  const rows = stdout.rows || 24;
  const cols = stdout.columns || 80;
  const modeLabel = MODE_LABEL[mode] ?? MODE_LABEL.default;
  const prompting = !!(permission || planApproval);

  // In an approval prompt the input box is off, so Ctrl+C is handled here: the first press stops
  // the turn (answering No), a second one within two seconds quits.
  useInput(
    (input, key) => {
      if (!(key.ctrl && input === 'c')) return;
      if (exitArmed) return void shutdown();
      controller.current?.abort();
      permission?.resolve('deny');
      planApproval?.resolve('keep');
      setExitArmed(true);
      clearTimeout(exitTimer.current);
      exitTimer.current = setTimeout(() => setExitArmed(false), 2000);
    },
    { isActive: prompting },
  );

  const menu = !prompting && inputStatus.matches.length ? inputStatus : null;
  const menuRows = menu ? menuWindow(menu.matches.length, menu.selected).rows : 0;
  const hint = prompting ? undefined : inputStatus.hint;
  const petHeight = PET_ROWS;
  const petWidth = CAT_W + PET_MARGIN;
  // The pet needs room above the prompt; a permission prompt needs ~16 rows of its own.
  const petShown = cols >= petWidth + 40 && rows >= petHeight + 8 && (!prompting || rows >= petHeight + 20);
  const leftWidth = cols - (petShown ? petWidth : 0);
  const showSpinner = busy && !prompting;
  const runningRows = running.length * 3;
  const todoMax = Math.max(3, Math.min(12, Math.floor((rows - 20) / 2)));
  const showTodos = busy && !prompting && todos.some(t => t.status !== 'completed');
  const todoRows = showTodos ? Math.min(todos.length, todoMax) + 3 : 0;
  const sideRows = runningRows + todoRows + (queue.length ? 1 : 0) + (say ? 3 : 0) + (showSpinner ? 2 : 0) + menuRows + 2;
  const textBudget = rows - 1 - (PROMPT_ROWS_UI + 1) - sideRows - 1;
  const promptBudget = rows - 1 - (petShown ? petHeight : 0) - 1 - 2;
  const reasoningTail = sanitize(l.reasoning.trim().split('\n').filter(Boolean).slice(-2).join(' ')).slice(-leftWidth + 10);
  const streaming =
    busy && l.text && textBudget >= 3
      ? tail(bulleted(renderMarkdown(sanitize(l.text), leftWidth - 2), paint.grass('⏺ '), leftWidth), leftWidth, textBudget)
      : '';
  const usage = (agent.totalUsage.promptTokens + agent.totalUsage.completionTokens).toLocaleString();

  const left = exitArmed
    ? 'Press Ctrl-C again to quit'
    : hint
      ? hint.text
      : modeLabel.text
        ? `${modeLabel.text} (shift+tab to cycle)`
        : busy
          ? 'esc to interrupt · type to queue a message'
          : '? /help for commands';

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={ready ? items : []}>
        {item => (
          <Box key={item.id} flexDirection="column">
            <MessageItem item={item} cwd={agent.cwd} />
          </Box>
        )}
      </Static>

      <Box ref={liveBox} flexDirection="column" justifyContent="flex-end" display={ready ? 'flex' : 'none'}>
        {/* Raon's live work on the left, the pet at the bottom right, sitting on the prompt box. */}
        <Box flexDirection="row" alignItems="flex-end">
          <Box flexDirection="column" width={leftWidth} minHeight={petShown ? petHeight : 0} justifyContent="flex-end">
            {busy && reasoningTail && !l.text && !prompting ? (
              <Box marginTop={1}>
                <Text color={C.dim} italic wrap="truncate-end">
                  ✻ {reasoningTail}
                </Text>
              </Box>
            ) : null}
            {streaming && !prompting ? (
              <Box marginTop={1}>
                <Text>{streaming}</Text>
              </Box>
            ) : null}
            {running.map(t => (
              <ToolLine key={t.id} item={t} cwd={agent.cwd} />
            ))}
            {showTodos ? (
              <Box marginTop={1}>
                <TodoList todos={todos} max={todoMax} />
              </Box>
            ) : null}
            {queue.length > 0 ? (
              <Box paddingLeft={2}>
                <Text color={C.dim} wrap="truncate-end">
                  ⏳ queued: {queue.map(q => sanitize(q.display)).join(' · ')}
                </Text>
              </Box>
            ) : null}
            {say && petShown ? (
              <Box justifyContent="flex-end">
                <Bubble text={say} />
              </Box>
            ) : null}
            {showSpinner ? <Spinner frame={frame} verb={l.verb} started={l.started} tokens={l.outTokens} /> : null}
            {menu ? <SuggestionMenu matches={menu.matches} selected={menu.selected} /> : null}
          </Box>
          {petShown ? <CatCompanion mood={mood} /> : null}
        </Box>

        {planApproval ? (
          <PlanApproval plan={planApproval.plan} maxLines={promptBudget} onAnswer={planApproval.resolve} />
        ) : permission ? (
          <PermissionPrompt
            tool={permission.tool}
            input={permission.input}
            cwd={agent.cwd}
            rules={permission.rules}
            maxLines={promptBudget}
            onAnswer={permission.resolve}
          />
        ) : null}
        {/* Kept mounted while a prompt is open, so a half-typed message survives it. */}
        <Box display={prompting ? 'none' : 'flex'} flexDirection="column">
          <PromptInput
            active={!prompting}
            history={history}
            suggestions={v => suggestCommands(v, commands)}
            onSubmit={submit}
            onKey={onKey}
            onStatus={setInputStatus}
          />
        </Box>
        <Box paddingX={2} height={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={exitArmed ? C.berry : hint ? hint.color : modeLabel.color} wrap="truncate-end">
              {left}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={C.dim}>
              <ContextMeter used={agent.contextTokens} total={agent.llm.config.contextWindow} />
              {cols >= 90 ? <Text color={C.dim}>  {usage} tokens</Text> : null}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
