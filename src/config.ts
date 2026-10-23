import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Empty or blank counts as unset: the OpenAI SDK turns a baseURL of '' into api.openai.com. */
const nonEmpty = (v: string | undefined) => v?.trim() || undefined;

/** Parses one .env line into [key, value]: trims and unquotes the value, drops ` # comments` and `export `. */
export function parseDotEnvLine(line: string): [string, string] | undefined {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) return undefined;
  const raw = m[2].trim();
  const quoted = raw.match(/^(['"])(.*?)\1\s*(?:#.*)?$/);
  return [m[1], quoted ? quoted[2] : raw.replace(/\s+#.*$/, '')];
}

/** The .env file each variable was loaded from; set variables missing here came from the environment. */
const loadedFrom = new Map<string, string>();

/** Minimal .env loader: never overrides variables already set in the environment. */
function loadDotEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const entry = parseDotEnvLine(line);
    // A blank `KEY=` line is a template, and an exported empty variable shouldn't hide a real value.
    if (!entry || !entry[1] || nonEmpty(process.env[entry[0]])) continue;
    process.env[entry[0]] = entry[1];
    loadedFrom.set(entry[0], file);
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Never read the .env of the project being worked on: a repo could point RAON_BASE_URL at
// someone else's server and collect your key. Only the install's own .env (a dev checkout)
// and ~/.zoicode/.env are trusted, and real environment variables win over both.
loadDotEnv(path.resolve(here, '..', '.env'));
loadDotEnv(path.join(os.homedir(), '.zoicode', '.env'));

export const CONFIG_DIR = path.join(os.homedir(), '.zoicode');
export const VERSION = '0.1.0';
export const DEFAULT_CONTEXT_WINDOW = 262_144;

/** Where a variable's value comes from: the .env file that set it, 'environment', or undefined if unset. */
export function envSource(name: string): string | undefined {
  return loadedFrom.get(name) ?? (nonEmpty(process.env[name]) ? 'environment' : undefined);
}

export interface Config {
  apiKey: string;
  baseURL: string;
  model: string;
  contextWindow: number;
}

/** Parses RAON_CONTEXT_WINDOW, a token count such as 131072 or 128k; blank means the default. */
export function parseContextWindow(raw: string | undefined): number {
  const value = raw?.trim();
  if (!value) return DEFAULT_CONTEXT_WINDOW;
  const m = value.match(/^(\d+)(k?)$/i);
  const tokens = m ? Number(m[1]) * (m[2] ? 1024 : 1) : NaN;
  // 0 would compact after every turn and NaN never; a value under 1024 is most likely "128" meant as 128k.
  if (!Number.isSafeInteger(tokens) || tokens < 1024) {
    throw new Error(`RAON_CONTEXT_WINDOW must be a token count such as 131072 or 128k, got ${JSON.stringify(raw)}`);
  }
  return tokens;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const apiKey = nonEmpty(overrides.apiKey) ?? nonEmpty(process.env.RAON_API_KEY);
  if (!apiKey) {
    throw new Error('RAON_API_KEY is not set. Run `zoicode --setup`, or export RAON_API_KEY.');
  }
  const baseURL = nonEmpty(overrides.baseURL) ?? nonEmpty(process.env.RAON_BASE_URL) ?? 'https://raon-api.krafton.ai/v1';
  const protocol = URL.parse(baseURL)?.protocol;
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`RAON_BASE_URL must be an http(s) URL, got ${JSON.stringify(baseURL)}`);
  }
  return {
    apiKey,
    baseURL,
    model: nonEmpty(overrides.model) ?? nonEmpty(process.env.RAON_MODEL) ?? 'raon-1-mini-preview',
    contextWindow: overrides.contextWindow ?? parseContextWindow(process.env.RAON_CONTEXT_WINDOW),
  };
}
