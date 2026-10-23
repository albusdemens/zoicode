import path from 'node:path';
import { LLM, type ChatMessage, type StreamEvent, type ToolCall, type Usage } from './llm.js';
import { buildSystemPrompt, loadMemory } from './prompt.js';
import { ALL_TOOLS, ExitPlanModeTool, findTool, toolSpecs, type Tool, type ToolContext, type ToolResult } from './tools/index.js';
import { isInsideDir, resolvePath, truncate } from './tools/types.js';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass';
export type PermissionAnswer = 'allow' | 'always' | 'deny';
/** How the user answered a plan: start implementing in a mode, or keep planning. */
export type PlanAnswer = 'acceptEdits' | 'default' | 'keep';

export type AgentEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'assistant'; text: string; reasoning: string }
  | { type: 'tool_start'; id: string; name: string; input: any; label: string }
  | { type: 'tool_end'; id: string; name: string; result: ToolResult; denied?: boolean }
  | { type: 'usage'; usage: Usage; total: Usage }
  | { type: 'error'; message: string }
  | { type: 'interrupted' };

export interface AgentOptions {
  llm: LLM;
  cwd: string;
  permissionMode?: PermissionMode;
  /** Asks the user about a call. `rules` is what an "always" answer stores; when empty, it only allows this call. */
  canUseTool?: (tool: Tool, input: any, rules: string[]) => Promise<PermissionAnswer>;
  maxSteps?: number;
  /** Subagents get no Task tool (no recursion) and no plan approval. */
  isSubagent?: boolean;
}

const EDIT_TOOLS = new Set(['Write', 'Edit']);
/** Non-read-only tools still usable in plan mode: Bash only for read-only commands, WebFetch with permission. */
const PLAN_TOOLS = new Set(['Bash', 'WebFetch']);
/** The most one tool result (about 25k tokens) or one user message with its attachments adds to the history. */
const MAX_RESULT_CHARS = 100_000;
const MAX_PROMPT_CHARS = 200_000;

/** Programs that run their arguments as a command: a rule for one of them would allow anything. */
const WRAPPERS = new Set([
  'env', 'sudo', 'doas', 'su', 'runuser', 'pkexec', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'busybox', 'eval', 'exec',
  'command', 'builtin', 'source', '.', 'trap', 'enable', 'coproc', 'time', 'xargs', 'parallel', 'timeout', 'nohup', 'nice',
  'ionice', 'stdbuf', 'setsid', 'flock', 'watch', 'chroot', 'unshare', 'nsenter', 'strace', 'script', 'ssh',
]);

const PLAN_REMINDER =
  'Plan mode is active. Do not make any changes yet: no file edits or writes, and no commands that change ' +
  'state. Research with read-only tools (Read, Glob, Grep, LS, read-only Bash commands, WebFetch), ' +
  'then call ExitPlanMode with a concise, concrete implementation plan for the user to approve. If the ' +
  'request is just a question, answer it directly instead.';

const SUBAGENT_PREFIX =
  'You are a subagent working on one task for the main Zoi Code agent. Work autonomously with your tools, ' +
  'then reply with a concise final report containing everything the main agent needs: findings, file paths ' +
  'with line numbers, and conclusions. Nobody sees your intermediate messages, only the final report.\n\nTask:\n';

export class Agent {
  llm: LLM;
  cwd: string;
  messages: ChatMessage[] = [];
  systemPrompt = '';
  permissionMode: PermissionMode;
  canUseTool?: AgentOptions['canUseTool'];
  /** Asked when the model presents a plan in plan mode. Without it, headless runs just stop at the plan. */
  onPlan?: (plan: string) => Promise<PlanAnswer>;
  /** Progress reports from long-running tools (e.g. what a subagent is doing). */
  onProgress?: (toolCallId: string, message: string) => void;
  /** Rules granted with "always allow": a tool name, "Bash(<program>)" or "WebFetch(<host>)". */
  allowRules = new Set<string>();
  totalUsage: Usage = { promptTokens: 0, completionTokens: 0 };
  /** Prompt tokens of the most recent request, i.e. how full the context is. */
  contextTokens = 0;
  ctx: ToolContext;
  maxSteps: number;
  isSubagent: boolean;
  /** Characters of history when contextTokens was measured, the base of estimateContextTokens(). */
  private measuredChars = 0;
  /** Set when the user rejects a tool call: the rest of the turn is skipped so they can say what to do instead. */
  private rejected = false;

  constructor(opts: AgentOptions) {
    this.llm = opts.llm;
    this.cwd = opts.cwd;
    this.permissionMode = opts.permissionMode ?? 'default';
    this.canUseTool = opts.canUseTool;
    this.maxSteps = opts.maxSteps ?? 100;
    this.isSubagent = !!opts.isSubagent;
    this.ctx = { cwd: opts.cwd, readFiles: new Map(), state: {} };
    if (!this.isSubagent) this.ctx.runSubagent = (description, prompt, progress) => this.runSubagent(prompt, progress);
    this.refreshSystemPrompt();
  }

  refreshSystemPrompt() {
    this.systemPrompt = buildSystemPrompt(this.cwd, loadMemory(this.cwd));
  }

  clear() {
    this.messages = [];
    this.contextTokens = 0;
    this.measuredChars = 0;
    this.ctx.readFiles.clear();
    this.ctx.state = {};
    this.refreshSystemPrompt();
  }

  /** The tools offered to the model in the current mode. */
  tools(): Tool[] {
    const tools = this.isSubagent ? ALL_TOOLS.filter(t => t.name !== 'Task') : ALL_TOOLS;
    if (this.permissionMode !== 'plan') return tools;
    return [...tools.filter(t => t.readOnly || PLAN_TOOLS.has(t.name)), ...(this.isSubagent ? [] : [ExitPlanModeTool])];
  }

  /** Rough size of the next request in tokens: the last measured usage plus ~3 characters per token added since. */
  estimateContextTokens(): number {
    return this.contextTokens + Math.max(0, Math.ceil((this.historyChars() - this.measuredChars) / 3));
  }

  private historyChars(): number {
    let chars = this.systemPrompt.length;
    for (const m of this.messages) {
      if (typeof m.content === 'string') chars += m.content.length;
      if (m.role === 'assistant') for (const c of m.tool_calls ?? []) if ('function' in c) chars += c.function.arguments.length;
    }
    return chars;
  }

  /**
   * The rules an "always" answer stores for this call; empty when it can only be allowed once. A Bash
   * rule names the program, and only ever approves a simple command of it (see isSimpleCommand).
   */
  alwaysRules(tool: Tool, input: any): string[] {
    if (tool.name === 'Bash') {
      const program = ruleProgram(String(input?.command ?? ''));
      return program ? [`Bash(${program})`] : [];
    }
    if (tool.name === 'WebFetch') {
      try {
        return [`WebFetch(${new URL(input?.url).hostname})`];
      } catch {
        return [];
      }
    }
    return [tool.name];
  }

  /** Whether a Write/Edit target lies inside the project once symlinks are followed. */
  private inProject(file: unknown): boolean {
    return typeof file === 'string' && isInsideDir(this.cwd, resolvePath(this.ctx, file));
  }

  private async permitted(tool: Tool, input: any): Promise<boolean> {
    if (tool.readOnly || this.permissionMode === 'bypass') return true;
    // Auto-accepted edits stay inside the project: a write anywhere else is asked about.
    if (this.permissionMode === 'acceptEdits' && EDIT_TOOLS.has(tool.name) && this.inProject(input.file_path)) return true;
    if (tool.isSafe?.(input)) return true;
    const rules = this.alwaysRules(tool, input);
    // A rule never covers a compound Bash command, nor a Write/Edit outside the project.
    const coverable = tool.name === 'Bash' ? isSimpleCommand(String(input.command)) : !EDIT_TOOLS.has(tool.name) || this.inProject(input.file_path);
    if (coverable && rules.length && rules.every(r => this.allowRules.has(r))) return true;
    if (!this.canUseTool) return false;
    const answer = await this.canUseTool(tool, input, rules);
    if (answer === 'deny') {
      this.rejected = true;
      return false;
    }
    if (answer === 'always') for (const r of rules) this.allowRules.add(r);
    return true;
  }

  /** Runs a child agent with a fresh context and returns its final report. */
  private async runSubagent(prompt: string, progress: (message: string) => void) {
    const child = new Agent({
      llm: this.llm,
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      // With nobody to ask (headless), the child denies on its own, as the parent does, instead of stopping.
      canUseTool: this.canUseTool && ((tool, input, rules) => this.canUseTool!(tool, input, rules)),
      isSubagent: true,
      maxSteps: 50,
    });
    child.allowRules = this.allowRules; // approvals carry over both ways
    let text = '';
    let toolUses = 0;
    try {
      for await (const ev of child.run(SUBAGENT_PREFIX + prompt, this.ctx.signal)) {
        if (ev.type === 'tool_start') {
          toolUses++;
          progress(`${ev.name}(${ev.label.length > 60 ? ev.label.slice(0, 57) + '…' : ev.label})`);
        } else if (ev.type === 'assistant' && ev.text.trim()) {
          text = ev.text.trim();
        } else if (ev.type === 'error') {
          text = text ? `${text}\n\n(Subagent stopped early: ${ev.message})` : `Subagent error: ${ev.message}`;
        }
      }
    } finally {
      this.totalUsage.promptTokens += child.totalUsage.promptTokens;
      this.totalUsage.completionTokens += child.totalUsage.completionTokens;
    }
    if (child.rejected) {
      this.rejected = true; // the user's "no" stops the main agent's turn too
      text = '(Subagent stopped: the user rejected one of its tool calls.)';
    }
    return { text, toolUses };
  }

  /** Executes one tool call with checked arguments, including permission checks and the plan-mode rules. */
  private async execute(tool: Tool | undefined, name: string, input: any): Promise<{ result: ToolResult; denied?: boolean }> {
    if (!tool) {
      return { result: { output: `Unknown tool "${name}". Available: ${this.tools().map(t => t.name).join(', ')}`, isError: true } };
    }

    if (tool.name === 'ExitPlanMode') {
      if (this.permissionMode !== 'plan') return { result: { output: 'Plan mode is not active; go ahead with the task.' } };
      if (!this.onPlan) {
        return { result: { output: 'Plan recorded. This session is non-interactive: stop here and give the plan as your final answer.', summary: 'Plan presented' } };
      }
      const answer = await this.onPlan(String(input.plan ?? ''));
      if (answer === 'keep') {
        return { result: { output: 'The user wants to keep planning. Ask what they would like to change, then present a revised plan.', summary: 'Kept planning' } };
      }
      this.permissionMode = answer;
      return {
        result: {
          output: `The user approved the plan and turned plan mode off (${answer === 'acceptEdits' ? 'file edits are auto-accepted' : 'each edit needs approval'}). Implement the plan now, keeping a TodoWrite list.`,
          summary: 'Plan approved',
        },
      };
    }

    const allowedInPlan = tool.readOnly || tool.name === 'WebFetch' || (tool.name === 'Bash' && tool.isSafe?.(input));
    if (this.permissionMode === 'plan' && !allowedInPlan) {
      return {
        result: {
          output: `Plan mode is active, so ${tool.name} is not allowed (only read-only tools and read-only commands). Finish researching and present your plan with ExitPlanMode.`,
          isError: true,
        },
      };
    }
    if (!(await this.permitted(tool, input))) {
      const output = this.rejected
        ? 'The user rejected this tool call and stopped the turn. Do not retry it; wait for their instructions.'
        : 'The user denied this tool call. Do not retry it; ask the user how to proceed.';
      return { denied: true, result: { output, isError: true } };
    }
    try {
      return { result: await tool.run(input, this.ctx) };
    } catch (e) {
      return { result: { output: `Error: ${(e as Error).message}`, isError: true } };
    }
  }

  /** Describes a failed request. One whose prompt no longer fits also marks the context as full. */
  private requestError(e: unknown): string {
    const message = String((e as Error)?.message ?? e);
    const status = (e as { status?: unknown })?.status;
    const window = this.llm.config.contextWindow;
    const tooLong =
      (status === 400 || status === 413) &&
      (/context length|context window|too long|exceed/i.test(message) || this.estimateContextTokens() > window * 0.9);
    if (!tooLong) return message;
    // A rejected request reports no usage: record the estimate, so a check of contextTokens sees a full context.
    this.contextTokens = Math.max(this.estimateContextTokens(), window || 0);
    this.measuredChars = this.historyChars();
    return `${message} The conversation no longer fits in the context window: compact it (/compact) or start over (/clear).`;
  }

  /** Runs the agent loop for one user message until the model stops calling tools. */
  async *run(userText: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    repairHistory(this.messages);
    const text = truncate(userText, MAX_PROMPT_CHARS);
    const content = this.permissionMode === 'plan' ? `${text}\n\n<system-reminder>${PLAN_REMINDER}</system-reminder>` : text;
    this.messages.push({ role: 'user', content });
    this.ctx.signal = signal;
    this.rejected = false;

    for (let step = 0; step < this.maxSteps; step++) {
      let done: Extract<StreamEvent, { type: 'done' }> | undefined;
      const partial = { text: '', reasoning: '' };
      try {
        const msgs: ChatMessage[] = [{ role: 'system', content: this.systemPrompt }, ...this.messages];
        for await (const ev of this.llm.stream(msgs, toolSpecs(this.tools()), signal)) {
          if (ev.type === 'reasoning' || ev.type === 'text') {
            partial[ev.type] += ev.delta;
            yield ev;
          } else if (ev.type === 'done') done = ev;
        }
      } catch (e) {
        if (signal?.aborted) {
          // Keep the text the user already saw; a half-streamed tool call is never stored or run.
          if (partial.text.trim()) {
            this.messages.push({ role: 'assistant', content: partial.text });
            yield { type: 'assistant', text: partial.text, reasoning: partial.reasoning };
          }
          yield { type: 'interrupted' };
          return;
        }
        yield { type: 'error', message: this.requestError(e) };
        return;
      }
      if (!done) return;

      if (done.usage) {
        this.totalUsage.promptTokens += done.usage.promptTokens;
        this.totalUsage.completionTokens += done.usage.completionTokens;
        this.contextTokens = done.usage.promptTokens + done.usage.completionTokens;
        this.measuredChars = this.historyChars();
        yield { type: 'usage', usage: done.usage, total: { ...this.totalUsage } };
      }

      const cutOff = cutOffReason(done.finishReason);
      const calls = done.toolCalls.map(call => prepareCall(call, cutOff));
      this.messages.push({
        role: 'assistant',
        content: done.text || null,
        ...(calls.length && {
          tool_calls: calls.map(c => ({ id: c.call.id, type: 'function' as const, function: { name: c.call.name, arguments: JSON.stringify(c.input) } })),
        }),
      });
      yield { type: 'assistant', text: done.text, reasoning: done.reasoning };

      if (!calls.length) {
        if (cutOff) yield { type: 'error', message: `The reply was cut off (${cutOff}).` };
        return;
      }

      for (const { call, tool, input, error } of calls) {
        yield { type: 'tool_start', id: call.id, name: tool?.name ?? call.name, input, label: tool ? safeLabel(tool, input) : call.name };

        this.ctx.progress = message => this.onProgress?.(call.id, message);
        let outcome: { result: ToolResult; denied?: boolean };
        if (signal?.aborted) outcome = { result: { output: 'Interrupted by user', isError: true } };
        else if (this.rejected) outcome = { result: { output: 'Not run: the user rejected an earlier tool call in this turn.', isError: true } };
        else if (error) outcome = { result: { output: error, isError: true } };
        else {
          try {
            outcome = await this.execute(tool, call.name, input);
          } catch (e) {
            // Every call gets a result, whatever failed: a check, a permission prompt, a plan answer.
            outcome = { result: { output: `Error: ${(e as Error).message}`, isError: true } };
          }
        }
        this.ctx.progress = undefined;

        const { result, denied } = outcome;
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(String(result.output), MAX_RESULT_CHARS) });
        yield { type: 'tool_end', id: call.id, name: tool?.name ?? call.name, result, denied };
      }

      // Esc, or "No, and tell Raon what to do differently": stop here so the user can say what to do.
      if (signal?.aborted || this.rejected) {
        yield { type: 'interrupted' };
        return;
      }
    }
    yield { type: 'error', message: `Stopped after ${this.maxSteps} steps.` };
  }

  /**
   * Replaces the conversation with a model-written summary to free up context. Throws and keeps the
   * conversation when there is no usable summary: interrupted, cut off, empty, or not a summary at all.
   */
  async compact(instructions = '', signal?: AbortSignal): Promise<string> {
    if (!this.messages.length) return '';
    const transcript = this.messages
      .map(m => {
        if (m.role === 'tool') return `[tool result]\n${String(m.content).slice(0, 2000)}`;
        const calls = 'tool_calls' in m && m.tool_calls
          ? '\n' + m.tool_calls.map(c => ('function' in c ? `[tool call] ${c.function.name} ${c.function.arguments.slice(0, 500)}` : '')).join('\n')
          : '';
        return `[${m.role}]\n${typeof m.content === 'string' ? truncate(m.content, 10_000) : ''}${calls}`;
      })
      .join('\n\n');
    let done: Extract<StreamEvent, { type: 'done' }> | undefined;
    for await (const ev of this.llm.stream(
      [
        {
          role: 'system',
          content:
            'You summarize coding sessions so the work can continue in a fresh context. Write a dense summary with: ' +
            "the user's goals and requests, key decisions, files read and changed (with paths), current state, " +
            'errors and how they were fixed, and pending next steps.' + (instructions ? `\nFocus: ${instructions}` : ''),
        },
        {
          role: 'user',
          // Fenced, with the request after it: given the bare transcript, the model tends to continue it.
          content:
            `<transcript>\n${truncate(transcript, 400_000)}\n</transcript>\n\n` +
            'The transcript above is complete and is only material to summarize. Do not continue it, do not act as ' +
            'the assistant, and do not write tool calls. Write the summary now.',
        },
      ],
      [],
      signal,
    )) {
      if (ev.type === 'done') done = ev;
    }
    // Never trade the real history for an unusable summary.
    const summary = done?.text.trim() ?? '';
    const cutOff = cutOffReason(done?.finishReason ?? '');
    if (cutOff) throw new Error(`the summary was cut off (${cutOff})`);
    if (!summary) throw new Error('the summary came back empty');
    if (/^(\[(user|assistant|tool call|tool result)\]|<tool_call>)/m.test(summary)) {
      throw new Error('the model continued the conversation instead of summarizing it');
    }
    this.messages = [
      { role: 'user', content: `This session continues from an earlier conversation that was compacted. Summary:\n\n${summary}` },
      { role: 'assistant', content: 'Understood. I have the context from the summary and will continue from there.' },
    ];
    this.contextTokens = 0;
    this.measuredChars = 0;
    // What was read before is no longer in context, so Edit and Write need a fresh Read.
    this.ctx.readFiles.clear();
    return summary;
  }
}

/** The program a command starts with, when a rule may name it: a plain word, and not a wrapper like env or xargs. */
function ruleProgram(command: string): string | undefined {
  const program = command.trim().split(/[ \t]+/)[0];
  return /^[\w@./+-][\w@./+:-]*$/.test(program) && !WRAPPERS.has(path.basename(program)) ? program : undefined;
}

/**
 * Whether a command is one simple command: no chaining, pipes, subshells, substitutions or redirections
 * outside quotes (2>&1 and >/dev/null are fine). A Bash allow rule never covers anything else.
 */
export function isSimpleCommand(command: string): boolean {
  const line = command.replace(/(^|[ \t])(\d?>&\d|&?\d?>[ \t]*\/dev\/null)(?=[ \t]|$)/g, '$1');
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") {
      if (ch === "'") quote = '';
    } else if (ch === '\\') {
      i++; // an escaped character is literal
    } else if (ch === '`' || (ch === '$' && line[i + 1] === '(')) {
      return false; // command substitution, which also runs inside double quotes
    } else if (quote === '"') {
      if (ch === '"') quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (';&|<>()\n'.includes(ch)) {
      return false;
    }
  }
  return !quote;
}

/** Why a reply is incomplete, or undefined when it finished normally. */
function cutOffReason(finishReason: string): string | undefined {
  if (finishReason === 'length') return 'it reached the length limit';
  if (!finishReason) return 'the response ended early';
  return undefined;
}

const article = (word: string) => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`;

/** How a JSON value reads in an error message: "null", "a string", "an array"... */
function describe(value: unknown): string {
  return value === null ? 'null' : article(Array.isArray(value) ? 'array' : typeof value);
}

/** Tool-call arguments must be a JSON object ('' counts as {}). */
function parseArguments(text: string): { input: Record<string, any> } | { problem: string } {
  if (!text.trim()) return { input: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { problem: 'the arguments are not valid JSON' };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { problem: `the arguments must be a JSON object, not ${describe(value)}` };
  }
  return { input: value as Record<string, any> };
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
    case 'boolean':
      return typeof value === type;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    default:
      return true; // arrays and objects are the tool's to check: some accept them JSON-encoded
  }
}

/**
 * Checks arguments against the tool's JSON schema: required parameters, primitive types and enums.
 * Optional parameters sent as null are dropped, since models often send null for "not set".
 */
function checkArgs(tool: Tool, input: Record<string, unknown>): string | undefined {
  const { properties = {}, required = [] } = tool.parameters as {
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
    required?: string[];
  };
  for (const key of new Set([...required, ...Object.keys(properties)])) {
    const { type, enum: choices } = properties[key] ?? {};
    const value = input[key];
    if (value === undefined || value === null) {
      if (required.includes(key)) {
        const got = Object.keys(input).map(k => `"${k}"`).join(', ') || 'none';
        return `missing required parameter "${key}"${type ? ` (${type})` : ''}; parameters given: ${got}`;
      }
      delete input[key];
    } else if (type && !hasType(value, type)) {
      return `parameter "${key}" must be ${article(type)}, not ${describe(value)}`;
    } else if (choices && !choices.includes(value)) {
      return `parameter "${key}" must be one of ${choices.map(c => JSON.stringify(c)).join(', ')}`;
    }
  }
  return undefined;
}

interface PreparedCall {
  call: ToolCall;
  tool?: Tool;
  /** The arguments as a JSON object; {} when they were unusable. */
  input: Record<string, any>;
  /** Why the call cannot run, told to the model as its result. */
  error?: string;
}

/**
 * Parses and checks a call's arguments before anything else sees them. Only a JSON object is ever stored:
 * the backend parses every stored call on each request and rejects the whole conversation otherwise.
 */
function prepareCall(call: ToolCall, cutOff: string | undefined): PreparedCall {
  const tool = findTool(call.name);
  const parsed = parseArguments(call.arguments);
  const input = 'input' in parsed ? parsed.input : {};
  if (!tool) return { call, input };
  if ('problem' in parsed && cutOff) {
    const error = `This tool call was cut off (${cutOff}) before its arguments were complete, so it was not run. Try again, splitting very large content into several smaller calls.`;
    return { call, tool, input, error };
  }
  const problem = 'problem' in parsed ? parsed.problem : checkArgs(tool, input);
  return { call, tool, input, error: problem && `Invalid arguments for ${tool.name}: ${problem}. Received: ${call.arguments.slice(0, 500)}` };
}

/**
 * Makes a saved or crashed history safe to send again: stored arguments that are not a JSON object
 * become "{}" (the backend rejects every request otherwise), and a call with no result gets one.
 */
function repairHistory(messages: ChatMessage[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    for (const c of m.tool_calls) {
      if ('function' in c && (typeof c.function.arguments !== 'string' || 'problem' in parseArguments(c.function.arguments))) {
        c.function.arguments = '{}';
      }
    }
    const answered = new Set<string>();
    for (let j = i + 1; j < messages.length && messages[j].role !== 'assistant'; j++) {
      const t = messages[j];
      if (t.role === 'tool') answered.add(t.tool_call_id);
    }
    let end = i + 1;
    while (end < messages.length && messages[end].role === 'tool') end++;
    const missing = m.tool_calls.filter(c => !answered.has(c.id));
    messages.splice(end, 0, ...missing.map(c => ({ role: 'tool' as const, tool_call_id: c.id, content: 'Not run: the session was interrupted.' })));
  }
}

function safeLabel(tool: Tool, input: any): string {
  try {
    const label: unknown = tool.label(input);
    return typeof label === 'string' ? label : '';
  } catch {
    return '';
  }
}
