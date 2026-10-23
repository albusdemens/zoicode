import chalk from 'chalk';
import type { Agent } from './agent.js';

export type OutputFormat = 'text' | 'json' | 'stream-json';
const OUTPUT_FORMATS: OutputFormat[] = ['text', 'json', 'stream-json'];

/** Non-interactive mode: run one prompt, print the result, exit. */
export async function runHeadless(agent: Agent, prompt: string, format: OutputFormat, verbose: boolean): Promise<number> {
  const err = (s: string) => process.stderr.write(s);
  // Checked before anything runs: an unknown format would run every tool and print nothing.
  if (!OUTPUT_FORMATS.includes(format)) {
    err(chalk.red(`Error: unknown output format "${format}" (use ${OUTPUT_FORMATS.join(', ')})\n`));
    return 1;
  }
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  let finalText = '';
  let failed = false;
  // Raon often opens a message with blank lines after reasoning; skip them.
  let atMessageStart = true;

  try {
    for await (const ev of agent.run(prompt, controller.signal)) {
      if (format === 'stream-json') {
        process.stdout.write(JSON.stringify(ev) + '\n');
      }
      switch (ev.type) {
        case 'text': {
          if (format !== 'text') break;
          const delta = atMessageStart ? ev.delta.replace(/^\s+/, '') : ev.delta;
          if (!delta) break;
          atMessageStart = false;
          process.stdout.write(delta);
          break;
        }
        case 'reasoning':
          if (verbose && format === 'text') err(chalk.dim.italic(ev.delta));
          break;
        case 'assistant':
          if (ev.text.trim()) finalText = ev.text.trim();
          if (format === 'text' && !atMessageStart && !ev.text.endsWith('\n')) process.stdout.write('\n');
          atMessageStart = true;
          break;
        case 'tool_start':
          if (verbose && format === 'text') err(chalk.cyan(`⏺ ${ev.name}(${ev.label})\n`));
          break;
        case 'tool_end':
          if (verbose && format === 'text') {
            const color = ev.result.isError ? chalk.red : chalk.dim;
            err(color(`  ⎿ ${ev.denied ? 'Denied' : ev.result.summary ?? ev.result.output.split('\n')[0]}\n`));
          }
          break;
        case 'error':
          failed = true;
          err(chalk.red(`Error: ${ev.message}\n`));
          break;
        case 'interrupted':
          failed = true;
          err(chalk.yellow('Interrupted\n'));
          break;
      }
    }
  } catch (e) {
    // agent.run reports failures as events; this is a backstop so that json output still gets its result line.
    failed = true;
    err(chalk.red(`Error: ${(e as Error).message}\n`));
  }

  if (format === 'json') {
    process.stdout.write(
      JSON.stringify({ result: finalText, is_error: failed, usage: agent.totalUsage, num_messages: agent.messages.length }) + '\n',
    );
  }
  return failed ? 1 : 0;
}
