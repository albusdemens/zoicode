import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Agent } from '../agent.js';
import { loadMemory } from '../prompt.js';
import { listSessions } from '../sessions.js';
import { sanitize } from './sanitize.js';
import { C } from './theme.js';

export interface CommandApi {
  agent: Agent;
  info: (text: string, color?: string) => void;
  clearScreen: () => void;
  exit: () => void;
  /** Send a prompt to the model as if the user typed it. */
  submit: (prompt: string, display?: string) => void;
  compact: (instructions: string) => Promise<void>;
  resume: (id: string) => void;
  /** Pet the cat. */
  pet: () => void;
  /** Built-in plus custom commands available in this session. */
  commands: Command[];
}

export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  run: (args: string, api: CommandApi) => void | Promise<void>;
  /** Where a custom command came from. */
  source?: 'project' | 'user';
  /**
   * Safe to run while Raon is working (it doesn't touch the conversation). Other commands wait in
   * the queue until the turn ends, so they can't change history under the running agent.
   */
  whileBusy?: boolean | ((args: string) => boolean);
}

export function runsWhileBusy(cmd: Command, args: string): boolean {
  return typeof cmd.whileBusy === 'function' ? cmd.whileBusy(args) : !!cmd.whileBusy;
}

const INIT_PROMPT = `Please analyze this codebase and create a ZOICODE.md file in the project root. It will be given to future coding agents working in this repository.

Include:
1. Commands to build, lint, test and run (including how to run a single test).
2. High-level architecture: the big picture that takes reading several files to understand.

Be concise. Do not list every file, and do not invent information that isn't in the repo. If a ZOICODE.md or CLAUDE.md exists, improve it instead. Also include important parts of README.md, .cursorrules or similar files. Start the file with:

# ZOICODE.md

This file provides guidance to Zoi Code when working with code in this repository.`;

export const COMMANDS: Command[] = [
  {
    name: 'help',
    whileBusy: true,
    aliases: ['?'],
    description: 'Show commands and shortcuts',
    run: (_a, api) => {
      const cmds = api.commands
        .map(c => `  /${c.name.padEnd(12)} ${c.description}${c.source ? ` (${c.source})` : ''}`)
        .join('\n');
      api.info(
        `Zoi Code help\n\nCommands\n${cmds}\n\nShortcuts\n` +
          '  !cmd         run a shell command directly\n' +
          '  #note        save a note to ZOICODE.md\n' +
          '  @path        attach a file to your message\n' +
          '  \\ + enter    new line\n' +
          '  ↑ / ↓        prompt history\n' +
          '  shift+tab    cycle permission mode\n' +
          '  esc          interrupt Raon\n' +
          '  ctrl+c ×2    quit',
        C.parchment,
      );
    },
  },
  {
    name: 'clear',
    aliases: ['reset', 'new'],
    description: 'Start a fresh conversation',
    run: (_a, api) => {
      api.agent.clear();
      api.clearScreen();
    },
  },
  {
    name: 'compact',
    description: 'Summarize the conversation to free up context',
    run: (args, api) => api.compact(args),
  },
  {
    name: 'cost',
    whileBusy: true,
    aliases: ['usage'],
    description: 'Show token usage for this session',
    run: (_a, api) => {
      const u = api.agent.totalUsage;
      const ctx = api.agent.contextTokens;
      const win = api.agent.llm.config.contextWindow;
      api.info(
        `Token usage\n` +
          `  Input tokens:   ${u.promptTokens.toLocaleString()}\n` +
          `  Output tokens:  ${u.completionTokens.toLocaleString()}\n` +
          `  Context in use: ${ctx.toLocaleString()} / ${win.toLocaleString()} (${((ctx / win) * 100).toFixed(1)}%)`,
        C.gold,
      );
    },
  },
  {
    name: 'model',
    whileBusy: args => !args.trim(),
    description: 'Show or switch the model',
    run: async (args, api) => {
      const llm = api.agent.llm;
      if (args.trim()) {
        llm.config.model = args.trim();
        api.info(`Switched to ${llm.config.model}`, C.grass);
        return;
      }
      const models = await llm.listModels().catch(() => [] as string[]);
      api.info(
        `Current model: ${llm.config.model}\nAvailable: ${models.join(', ') || '(could not list)'}\nUse /model <name> to switch.`,
        C.parchment,
      );
    },
  },
  {
    name: 'init',
    description: 'Write a ZOICODE.md with notes about this project',
    run: (_a, api) => api.submit(INIT_PROMPT, '/init'),
  },
  {
    name: 'memory',
    whileBusy: true,
    description: 'Show loaded memory files (ZOICODE.md, CLAUDE.md)',
    run: (_a, api) => {
      const files = loadMemory(api.agent.cwd);
      api.info(
        files.length
          ? '🧠 Memory files\n' + files.map(f => `  ${f.path} (${f.content.split('\n').length} lines)`).join('\n')
          : 'No memory files yet. Run /init, or start a line with # to add a note.',
        C.purple,
      );
    },
  },
  {
    name: 'permissions',
    whileBusy: true,
    description: 'Show the permission mode and allowed rules',
    run: (_a, api) => {
      const rules = [...api.agent.allowRules];
      api.info(
        `🔐 Permission mode: ${api.agent.permissionMode}\n` +
          `Always allowed this session: ${rules.length ? rules.join(', ') : '(none)'}\n` +
          'Read-only tools and safe commands (ls, cat, git status…) never ask, except in credential folders like ~/.ssh.',
        C.parchment,
      );
    },
  },
  {
    name: 'resume',
    whileBusy: args => !args.trim(),
    description: 'Resume a previous conversation in this directory',
    run: (args, api) => {
      const sessions = listSessions(api.agent.cwd);
      if (args.trim()) return api.resume(args.trim());
      if (!sessions.length) return api.info('No saved sessions here yet.');
      api.info(
        '📼 Saved sessions (use /resume <id>)\n' +
          sessions
            .slice(0, 10)
            .map(s => `  ${s.id}  ${new Date(s.updatedAt).toLocaleString()}  ${s.title || '(untitled)'}`)
            .join('\n'),
        C.parchment,
      );
    },
  },
  {
    name: 'export',
    whileBusy: true,
    description: 'Save the conversation to a markdown file',
    run: (args, api) => {
      const file = path.resolve(api.agent.cwd, args.trim() || `zoicode-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.md`);
      const parts: string[] = [`# Zoi Code conversation\n\n${new Date().toLocaleString()} · ${api.agent.cwd}\n`];
      for (const m of api.agent.messages) {
        if (m.role === 'user' && typeof m.content === 'string') {
          parts.push(`## You\n\n${m.content.replace(/\n\n<system-reminder>[\s\S]*?<\/system-reminder>$/, '')}`);
        } else if (m.role === 'assistant') {
          if (typeof m.content === 'string' && m.content.trim()) parts.push(`## Raon\n\n${m.content.trim()}`);
          for (const c of m.tool_calls ?? []) if ('function' in c) parts.push(`> 🔧 **${c.function.name}** \`${c.function.arguments.slice(0, 300)}\``);
        }
      }
      fs.writeFileSync(file, parts.join('\n\n') + '\n');
      api.info(`📜 Exported ${api.agent.messages.length} messages to ${path.relative(api.agent.cwd, file) || file}`, C.grass);
    },
  },
  {
    name: 'pet',
    whileBusy: true,
    description: 'Pet the cat',
    run: (_a, api) => {
      api.pet();
      api.info('♥ You pet the cat. It purrs.', C.berry);
    },
  },
  {
    name: 'exit',
    whileBusy: true,
    aliases: ['quit', 'bye'],
    description: 'Quit',
    run: (_a, api) => api.exit(),
  },
];

/** Splits optional `---` frontmatter (key: value lines) from a markdown body. */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: m[2] };
}

/**
 * Custom commands are markdown prompt files, like Claude Code's: ~/.zoicode/commands/*.md (user) and
 * .zoicode/commands/*.md (project). .claude/commands is read too, so existing commands just work.
 * `$ARGUMENTS` in the file is replaced with whatever follows the command.
 */
export function loadCustomCommands(cwd: string, skipped: string[] = []): Command[] {
  const home = os.homedir();
  const dirs: [string, 'user' | 'project'][] = [
    [path.join(home, '.claude', 'commands'), 'user'],
    [path.join(home, '.zoicode', 'commands'), 'user'],
    [path.join(cwd, '.claude', 'commands'), 'project'],
    [path.join(cwd, '.zoicode', 'commands'), 'project'],
  ];
  const found = new Map<string, Command>();
  for (const [dir, source] of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const file of files) {
      const name = file.slice(0, -3).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const full = path.join(dir, file);
      let text: string;
      try {
        // statSync follows symlinks; checking isFile also avoids blocking forever on a FIFO named *.md.
        if (!fs.statSync(full).isFile()) throw new Error('not a regular file');
        text = fs.readFileSync(full, 'utf8');
      } catch {
        skipped.push(full);
        continue;
      }
      const { meta, body } = parseFrontmatter(text);
      const firstLine = body.trim().split('\n')[0].replace(/^#+\s*/, '');
      found.set(name, {
        name,
        source,
        description: sanitize(meta.description || firstLine || 'Custom command').slice(0, 60),
        run: (args, api) => {
          const prompt = body.includes('$ARGUMENTS')
            ? body.replaceAll('$ARGUMENTS', args)
            : args ? `${body.trim()}\n\nArguments: ${args}` : body.trim();
          api.submit(prompt, `/${name}${args ? ' ' + args : ''}`);
        },
      });
    }
  }
  return [...found.values()].filter(c => !COMMANDS.some(b => b.name === c.name || b.aliases?.includes(c.name)));
}

export function findCommand(name: string, commands: Command[] = COMMANDS): Command | undefined {
  return commands.find(c => c.name === name || c.aliases?.includes(name));
}

export function suggestCommands(value: string, commands: Command[] = COMMANDS) {
  const q = value.slice(1).toLowerCase();
  return commands.filter(c => c.name.startsWith(q) || c.aliases?.some(a => a.startsWith(q)))
    .sort((a, b) => Number(b.name === q) - Number(a.name === q))
    .map(c => ({ name: c.name, description: c.description }));
}

/** Expand @path mentions into attached file contents. */
export function expandMentions(text: string, cwd: string, readFiles: Map<string, number>): string {
  const attached: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([^\s]+)/g)) {
    const abs = path.resolve(cwd, m[1]);
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size < 256_000) {
        attached.push(`<file path="${abs}">\n${fs.readFileSync(abs, 'utf8')}\n</file>`);
        readFiles.set(abs, stat.mtimeMs);
      } else if (stat.isDirectory()) {
        attached.push(`<directory path="${abs}">\n${fs.readdirSync(abs).join('\n')}\n</directory>`);
      }
    } catch { /* not a path */ }
  }
  return attached.length ? `${text}\n\nAttached files:\n${attached.join('\n\n')}` : text;
}
