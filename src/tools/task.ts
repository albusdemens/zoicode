import type { Tool } from './types.js';

export const TaskTool: Tool<{ description: string; prompt: string }> = {
  name: 'Task',
  description:
    'Launch a subagent with its own fresh context to handle a self-contained task, such as searching a large ' +
    'codebase, investigating a question across many files, or researching docs. It has the same tools as you ' +
    '(except Task) and returns one final report. Give it a complete, specific prompt: it cannot see this ' +
    'conversation. Use it to keep your own context small; launch several in one turn for independent tasks.',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short (3-5 word) description of the task' },
      prompt: { type: 'string', description: 'Full instructions for the subagent, including what to report back' },
    },
    required: ['description', 'prompt'],
  },
  readOnly: true,
  label: i => i.description,
  async run(input, ctx) {
    if (!ctx.runSubagent) return { output: 'Subagents are not available here.', isError: true };
    const { text, toolUses } = await ctx.runSubagent(input.description, input.prompt, m => ctx.progress?.(m));
    return {
      output: text || '(the subagent returned no report)',
      summary: `Done · ${toolUses} tool use${toolUses === 1 ? '' : 's'}`,
    };
  },
};
