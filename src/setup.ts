import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { CONFIG_DIR, envSource, loadConfig, parseDotEnvLine } from './config.js';
import { LLM } from './llm.js';

const gold = chalk.hex('#F7C548');
const dim = chalk.hex('#8C7A6B');
const berry = chalk.hex('#D9466A');
const grass = chalk.hex('#7BC043');

/** Reads a line without echoing it, showing a dot per character. */
function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  let value = '';
  return new Promise(resolve => {
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          value += ch;
          process.stdout.write('•');
        }
      }
    };
    stdin.on('data', onData);
  });
}

/** Scripted setup (`echo "$KEY" | zoicode --setup`): the key is the first non-empty line of stdin. */
function readKeyFromStdin(): Promise<string> {
  const stdin = process.stdin;
  stdin.setEncoding('utf8');
  return new Promise(resolve => {
    let data = '';
    const done = () => {
      stdin.off('data', onData).off('end', done).off('error', done);
      stdin.destroy(); // pause() alone re-arms the read, and a pipe left open would keep the process alive
      resolve(data.trim().split(/\r?\n/)[0].trim());
    };
    const onData = (chunk: string) => {
      data += chunk;
      if (/\S[^\n]*\n/.test(data)) done(); // a non-empty line is complete
    };
    stdin.on('data', onData).once('end', done).once('error', done);
    stdin.resume();
  });
}

/** Saves KEY=value pairs to ~/.zoicode/.env, readable only by the user. */
export function saveCredentials(values: Record<string, string>) {
  const file = path.join(CONFIG_DIR, '.env');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // Drop the old lines for these keys however they were written (`KEY = x`, `export KEY=x`): the first one wins.
  const lines = existing.split('\n').filter(l => {
    const key = parseDotEnvLine(l)?.[0];
    return l.trim() && !(key && key in values);
  });
  for (const [k, v] of Object.entries(values)) lines.push(`${k}=${v}`);
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Checks a key against the API and saves it. Returns false, after saying why, if the key doesn't work. */
async function checkAndSave(key: string): Promise<boolean> {
  // Outside the try: a bad RAON_BASE_URL is fatal, not a reason to ask for another key.
  const llm = new LLM(loadConfig({ apiKey: key }));
  process.stdout.write(dim('Checking the key… '));
  let models: string[];
  try {
    models = await llm.listModels();
  } catch (e) {
    console.log(berry(`✗ ${(e as Error).message}`));
    return false;
  }
  console.log(grass(`✓ works! (${models.length} model${models.length === 1 ? '' : 's'} available)`));
  // The environment and the install's .env win over ~/.zoicode/.env; look before process.env changes.
  const shadow = process.env.RAON_API_KEY === key ? undefined : envSource('RAON_API_KEY');
  process.env.RAON_API_KEY = key;
  let file: string;
  try {
    file = saveCredentials({ RAON_API_KEY: key });
  } catch (e) {
    console.log(berry(`⚠ The key works but could not be saved: ${(e as Error).message}`));
    console.log(dim('It is used for this run only. Export RAON_API_KEY to keep it.\n'));
    return true;
  }
  console.log(dim(`Saved to ${file}\n`));
  if (shadow === 'environment') {
    console.log(berry(`⚠ Your environment also sets RAON_API_KEY, and it wins over ${file}.`));
    console.log(dim('Unset or update it, or the next start will still use the old key.\n'));
  } else if (shadow && shadow !== file) {
    console.log(berry(`⚠ ${shadow} also sets RAON_API_KEY and is read first.`));
    console.log(dim('Remove or update that line, or the next start will still use the old key.\n'));
  }
  return true;
}

/** First-run setup: ask for the Raon API key, check it, and save it. */
export async function runSetup(): Promise<void> {
  if (!process.stdin.isTTY) {
    // No terminal to type into (a pipe, CI, ssh without -t): one key from stdin, one try.
    const key = await readKeyFromStdin();
    if (!key) {
      console.error(berry('No API key given. Run zoicode --setup in a terminal, pipe the key in (echo "$KEY" | zoicode --setup), or export RAON_API_KEY.'));
      process.exit(1);
    }
    if (!(await checkAndSave(key))) process.exit(1);
    return;
  }
  console.log(`\n${gold.bold('Welcome to Zoi Code!')} ${dim("Let's get you set up.")}\n`);
  console.log(dim('Zoi Code talks to the Raon API. Paste your API key below; it is saved to'));
  console.log(dim(`${path.join(CONFIG_DIR, '.env')} (readable only by you).\n`));

  for (let attempt = 1; attempt <= 3; attempt++) {
    const key = await askSecret(gold('Raon API key: '));
    if (!key) {
      console.log(berry('No key entered.'));
      continue;
    }
    if (await checkAndSave(key)) return;
  }
  console.log(berry(`\nSetup failed. You can also export RAON_API_KEY, or put RAON_API_KEY=<key> in ${path.join(CONFIG_DIR, '.env')}.`));
  console.log(dim('(A .env file in your project is never read.)'));
  process.exit(1);
}
