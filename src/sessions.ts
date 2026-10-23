import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_DIR } from './config.js';
import type { ChatMessage } from './llm.js';

export interface Session {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  messages: ChatMessage[];
}

function projectDir(cwd: string): string {
  return path.join(CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

export function newSession(cwd: string): Session {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID().slice(0, 8), cwd, createdAt: now, updatedAt: now, title: '', messages: [] };
}

/** Folders whose session files were already made private in this run (see saveSession). */
const tightened = new Set<string>();

export function saveSession(s: Session) {
  if (!s.messages.length) return;
  const dir = projectDir(s.cwd);
  // A session holds whatever the model read, so only the user may read it, like the key in .env.
  for (const d of [CONFIG_DIR, path.dirname(dir), dir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    fs.chmodSync(d, 0o700);
  }
  if (!tightened.has(dir)) {
    tightened.add(dir);
    // Files saved by older versions were readable by everyone.
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) fs.chmodSync(path.join(dir, f), 0o600);
  }
  s.updatedAt = new Date().toISOString();
  if (!s.title) {
    const first = s.messages.find(m => m.role === 'user' && typeof m.content === 'string');
    s.title = String(first?.content ?? '').split('\n')[0].slice(0, 80);
  }
  const file = path.join(dir, `${s.id}.json`);
  fs.writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
  fs.chmodSync(file, 0o600); // the mode above only applies to a new file
}

export function listSessions(cwd: string): Session[] {
  const dir = projectDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Session;
      } catch {
        return null;
      }
    })
    .filter((s): s is Session => !!s)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function loadSession(cwd: string, id: string): Session | undefined {
  return listSessions(cwd).find(s => s.id === id || s.id.startsWith(id));
}

/**
 * The session that -c (the latest) or -r <id> asks for, otherwise a new one; -c wins over -r.
 * Undefined when no saved session matches the id. A bare -r (`true`) gets a new session here:
 * listing the saved ones is up to the caller.
 */
export function resolveSession(cwd: string, continueLast: boolean, resume?: string | boolean): Session | undefined {
  if (continueLast) return listSessions(cwd)[0] ?? newSession(cwd);
  if (typeof resume === 'string') return loadSession(cwd, resume);
  return newSession(cwd);
}
