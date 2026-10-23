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

export class LLM {
  private client: OpenAI;

  constructor(public config: Config) {
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 3 });
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
        let call = calls[tc.index];
        if (!call) {
          call = calls[tc.index] = { id: tc.id ?? `call_${tc.index}`, name: '', arguments: '' };
        }
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.arguments += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    // openai v7 ends an aborted stream quietly: report it as an abort, never as a finished reply.
    signal?.throwIfAborted();

    yield { type: 'done', text, reasoning, toolCalls: calls.filter(Boolean), usage, finishReason };
  }
}
