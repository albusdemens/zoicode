import os from 'node:os';
import path from 'node:path';
import { realTarget } from './types.js';

/**
 * Places in the home folder that hold credentials: Zoi Code's own key and sessions, SSH, cloud and
 * GPG keys, and the tokens of package managers and CLIs. Reading and searching don't ask anywhere
 * else, but here the user is asked first, so a prompt-injected model can't quietly pull a secret
 * into the conversation (and from there into the request to the API and the saved session).
 */
const SECRET_PATHS = [
  '.zoicode', '.ssh', '.aws', '.azure', '.gnupg', '.password-store', '.kube', '.docker/config.json',
  '.config/gh', '.config/gcloud', '.netrc', '.npmrc', '.pypirc', '.git-credentials',
  '.cargo/credentials', '.cargo/credentials.toml', '.gem/credentials',
];

function secretPaths(): string[] {
  const home = os.homedir();
  return SECRET_PATHS.map(p => realTarget(path.join(home, p)));
}

function within(dir: string, p: string): boolean {
  const rel = path.relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** Whether abs (symlinks followed) is a credential folder or file, or inside one. */
export function inSecrets(abs: string): boolean {
  const target = realTarget(abs);
  return secretPaths().some(secret => within(secret, target));
}

/** Whether a credential folder or file is inside abs, so a recursive read of abs would reach it. */
export function containsSecrets(abs: string): boolean {
  const target = realTarget(abs);
  return secretPaths().some(secret => within(target, secret) && secret !== target);
}

/**
 * A quick check for file walks, which see many paths: whether an absolute path (as the walk spells it)
 * is a credential folder or file, or inside one. The secret paths are resolved once.
 */
export function secretMatcher(): (abs: string) => boolean {
  const secrets = secretPaths();
  return abs => secrets.some(secret => within(secret, abs));
}

/**
 * The fixed part of a path that may contain wildcards, up to the first segment with one: what a
 * search or a shell glob can reach at most. `src/*.ts` gives `src`, `~/.s*h/id` gives `~`.
 */
export function fixedPrefix(pattern: string): string {
  const parts = pattern.split('/');
  const i = parts.findIndex(p => /[*?[{]/.test(p));
  return i === -1 ? pattern : parts.slice(0, i).join('/') || (pattern.startsWith('/') ? '/' : '.');
}
