import type { Tool } from './types.js';

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const STATUSES = ['pending', 'in_progress', 'completed'];

/**
 * The model's list, or what is wrong with it. Open models often send the array JSON-encoded as a string, so that
 * is accepted; anything else must be rejected rather than read as an empty list, which would wipe the to-do list.
 */
function parseTodos(value: unknown): Todo[] | string {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return '`todos` must be an array, but got a string that is not valid JSON.';
    }
  }
  if (!Array.isArray(value)) return `\`todos\` must be an array of {content, status} objects, but got ${value === null ? 'null' : typeof value}.`;
  const bad = value.findIndex(t => typeof t?.content !== 'string' || !STATUSES.includes(t?.status));
  if (bad >= 0) {
    return `todos[${bad}] must be {"content": string, "status": "pending" | "in_progress" | "completed"}, but got ${JSON.stringify(value[bad])?.slice(0, 120)}.`;
  }
  return value.map(t => ({ content: t.content, status: t.status }));
}

export const TodoWriteTool: Tool<{ todos: Todo[] }> = {
  name: 'TodoWrite',
  description:
    'Create or update the task list for the current work. Use it for multi-step tasks (3+ steps): write the ' +
    'whole list each time, keep exactly one item in_progress, and mark items completed as soon as they are done.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  readOnly: true,
  label: i => {
    const todos = parseTodos(i.todos);
    return typeof todos === 'string' ? 'invalid list' : `${todos.length} items`;
  },
  async run(input, ctx) {
    const todos = parseTodos(input.todos);
    if (typeof todos === 'string') {
      return { output: `${todos} The previous list is unchanged; call TodoWrite again with the whole list as an array.`, isError: true };
    }
    ctx.state.todos = todos;
    const done = todos.filter(t => t.status === 'completed').length;
    return {
      output: 'Todo list updated. Keep working through it.\n' + todos.map(t => `[${t.status}] ${t.content}`).join('\n'),
      summary: `${done}/${todos.length} done`,
    };
  },
};
