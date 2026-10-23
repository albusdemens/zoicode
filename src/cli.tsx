import fs from 'node:fs';
import { Command, Option } from 'commander';
import { loadConfig, VERSION } from './config.js';
import { LLM } from './llm.js';
import { Agent, type PermissionMode } from './agent.js';
import { runHeadless, type OutputFormat } from './headless.js';
import { resolveSession, saveSession } from './sessions.js';

const PERMISSION_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];
const OUTPUT_FORMATS: OutputFormat[] = ['text', 'json', 'stream-json'];

async function readStdin(): Promise<string> {
  // Only read piped/redirected input; a terminal would wait for typing forever.
  const stat = fs.fstatSync(0);
  if (!stat.isFIFO() && !stat.isFile() && !stat.isSocket()) return '';
  const stdin = process.stdin;
  stdin.setEncoding('utf8'); // keeps multi-byte characters that straddle two chunks intact
  return new Promise(resolve => {
    let data = '';
    let timer: NodeJS.Timeout | undefined;
    const onData = (chunk: string) => {
      clearTimeout(timer);
      data += chunk;
    };
    const finish = () => {
      clearTimeout(timer);
      stdin.off('data', onData);
      resolve(data);
    };
    stdin.on('data', onData).once('end', finish).once('error', finish);
    // Node.js parents pass a socket: execFileSync({ input }) closes it after writing, but spawn()
    // and exec() leave it open unless the caller ends it, so don't wait forever on a silent one.
    if (stat.isSocket()) {
      timer = setTimeout(() => {
        process.stderr.write('Warning: no stdin data received in 3s, continuing without it. End stdin (or use < /dev/null) to skip the wait.\n');
        stdin.pause();
        finish();
      }, 3000);
    }
  });
}

/** process.exit() drops output still queued for a pipe, so let stdout and stderr flush first. */
async function exitWhenFlushed(code: number): Promise<never> {
  await Promise.all([process.stdout, process.stderr].map(s => new Promise(resolve => s.write('', resolve))));
  process.exit(code);
}

const program = new Command()
  .name('zoicode')
  .description('Zoi Code: a cozy coding agent for your terminal, powered by Raon')
  .version(VERSION)
  .argument('[prompt...]', 'initial prompt')
  .option('-p, --print', 'print the response and exit (non-interactive)')
  .option('-m, --model <model>', 'model to use')
  .addOption(new Option('--output-format <format>', 'with --print: output format').choices(OUTPUT_FORMATS).default('text'))
  .addOption(new Option('--permission-mode <mode>', 'which tool calls run without asking').choices(PERMISSION_MODES).default('default'))
  .option('--yolo', 'skip all permission prompts (same as --permission-mode bypass)')
  .option('-c, --continue', 'continue the most recent session in this directory')
  .option('-r, --resume [id]', 'resume a session by id (without an id: list them)')
  .option('--verbose', 'show tool calls and reasoning in --print mode')
  .option('--no-splash', 'skip the opening scene')
  .option('--setup', 'enter or change your Raon API key')
  .action(async (promptWords: string[], opts) => {
    const interactive = process.stdin.isTTY && !opts.print;
    if (opts.setup || (interactive && !process.env.RAON_API_KEY?.trim())) {
      const { runSetup } = await import('./setup.js');
      await runSetup();
      if (opts.setup && !promptWords.length) return;
    }
    const config = loadConfig({ model: opts.model });
    const llm = new LLM(config);
    const permissionMode: PermissionMode = opts.yolo ? 'bypass' : opts.permissionMode;
    let prompt = promptWords.join(' ');

    if (opts.print) {
      const cwd = process.cwd();
      // Look the session up before reading the prompt: `-p -r "fix it"` makes "fix it" the id,
      // and "No session matching" explains that better than "No prompt given".
      if (opts.resume === true && !opts.continue) {
        console.error('--resume needs a session id with --print. Run zoicode -r to list the sessions here.');
        process.exit(1);
      }
      const session = resolveSession(cwd, !!opts.continue, opts.resume);
      if (!session) {
        console.error(`No session matching "${opts.resume}" in ${cwd}. (-r takes the next word as the id: put the prompt after the id.)`);
        process.exit(1);
      }
      const stdin = opts.setup ? '' : await readStdin(); // a piped --setup has used up stdin
      if (stdin) prompt = prompt ? `${prompt}\n\n${stdin}` : stdin;
      if (!prompt.trim()) {
        console.error('No prompt given. Usage: zoicode -p "your prompt"');
        process.exit(1);
      }
      // Headless mode has nobody to ask, so non-safe tools need --yolo / acceptEdits.
      const agent = new Agent({ llm, cwd, permissionMode });
      agent.messages = session.messages;
      // A reader that goes away early (`| head`) makes writes fail with EPIPE: stop quietly.
      process.stdout.on('error', e => {
        if ((e as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
        throw e;
      });
      const code = await runHeadless(agent, prompt, opts.outputFormat as OutputFormat, !!opts.verbose);
      session.messages = agent.messages;
      try { saveSession(session); } catch { /* disk full etc.: the run itself still counts */ }
      await exitWhenFlushed(code);
    }

    const { startInteractive } = await import('./ui/start.js');
    await startInteractive({ llm, permissionMode, prompt, continueLast: !!opts.continue, resume: opts.resume, splash: opts.splash ? undefined : false });
  });

program.parseAsync().catch(e => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
