import type { Tool } from './types.js';

/**
 * Only offered in plan mode. The agent intercepts calls to it and asks the user to
 * approve the plan, so `run` is never reached in practice.
 */
export const ExitPlanModeTool: Tool<{ plan: string }> = {
  name: 'ExitPlanMode',
  description:
    'Call this when you are in plan mode and have finished researching: present your implementation plan ' +
    '(markdown, concise, concrete steps and files) for the user to approve. Only use it for tasks that need ' +
    'code changes, not for pure research questions.',
  parameters: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The plan, in markdown' } },
    required: ['plan'],
  },
  readOnly: true,
  label: () => 'plan ready',
  async run() {
    return { output: 'Plan approval is handled by the agent.', isError: true };
  },
};
