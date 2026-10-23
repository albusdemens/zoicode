import OpenAI from 'openai';
import type { Config } from './config.js';

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ToolSpec = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export type StreamEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  // finishReason is '' when the stream ended without one: the reply may be cut off.
  | { type: 'done'; text: string; reasoning: string; toolCalls: ToolCall[]; usage?: Usage; finishReason: string };

/** The most tool calls taken from one reply, and the most argument text per call (a big file for Write fits). */
const MAX_TOOL_CALLS = 128;
const MAX_ARGUMENT_CHARS = 20_000_000;

export class LLM {
  private client: OpenAI;

  constructor(public config: Config) {
    // The SDK adds OPENAI_* settings from the environment (organization, project, admin key, custom
    // headers) to every request. They belong to the user's OpenAI setup, not to the Raon endpoint.
    // The custom headers are read while the client is built, so they are hidden just for that.
    const customHeaders = process.env.OPENAI_CUSTOM_HEADERS;
    delete process.env.OPENAI_CUSTOM_HEADERS;
    try {
      this.client = new OpenAI({
        apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 3, organization: null, project: null, adminAPIKey: null,
      });
    } finally {
      if (customHeaders !== undefined) process.env.OPENAI_CUSTOM_HEADERS = customHeaders;
    }
  }

  async listModels(): Promise<string[]> {
    const res = await this.client.models.list();
    return res.data.map(m => m.id);
  }

  /** Streams one completion, yielding deltas and finally the assembled message. */
  async *stream(messages: ChatMessage[], tools: ToolSpec[], signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.config.model,
        messages,
        tools: tools.length ? tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );

    let text = '';
    let reasoning = '';
    let finishReason = '';
    let usage: Usage | undefined;
    const calls: ToolCall[] = [];

    for await (const chunk of stream) {
      if (chunk.usage) {
        usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta as typeof choice.delta & { reasoning?: string; reasoning_content?: string };
      const r = delta.reasoning ?? delta.reasoning_content;
      if (r) {
        reasoning += r;
        yield { type: 'reasoning', delta: r };
      }
      if (delta.content) {
        text += delta.content;
        yield { type: 'text', delta: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        // The endpoint is not trusted: its index is used only when it is a small count (a huge one
        // stalled the app, "__proto__" reached Array.prototype), and names and arguments are capped.
        const i = tc.index;
        if (!Number.isInteger(i) || i < 0 || i >= MAX_TOOL_CALLS) continue;
        let call = calls[i];
        if (!call) {
          call = calls[i] = { id: typeof tc.id === 'string' ? tc.id : `call_${i}`, name: '', arguments: '' };
        }
        if (typeof tc.id === 'string' && tc.id) call.id = tc.id.slice(0, 200);
        if (typeof tc.function?.name === 'string') call.name = (call.name + tc.function.name).slice(0, 200);
        if (typeof tc.function?.arguments === 'string' && call.arguments.length < MAX_ARGUMENT_CHARS) call.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    // openai v7 ends an aborted stream quietly: report it as an abort, never as a finished reply.
    signal?.throwIfAborted();

    yield { type: 'done', text, reasoning, toolCalls: calls.filter(Boolean), usage, finishReason };
  }
}
