import type { ToolSpec } from '../llm.js';
import { BashTool } from './bash.js';
import { EditTool, LSTool, ReadTool, WriteTool } from './files.js';
import { GlobTool, GrepTool } from './search.js';
import { ExitPlanModeTool } from './plan.js';
import { TaskTool } from './task.js';
import { TodoWriteTool } from './todo.js';
import type { Tool } from './types.js';
import { WebFetchTool } from './web.js';

/** Tools offered in normal operation. ExitPlanMode is added only in plan mode. */
export const ALL_TOOLS: Tool[] = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool, LSTool, TodoWriteTool, WebFetchTool, TaskTool];

export { ExitPlanModeTool };

export function findTool(name: string): Tool | undefined {
  return [...ALL_TOOLS, ExitPlanModeTool].find(t => t.name.toLowerCase() === name.toLowerCase());
}

export function toolSpecs(tools: Tool[] = ALL_TOOLS): ToolSpec[] {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export type { Tool, ToolContext, ToolResult } from './types.js';
