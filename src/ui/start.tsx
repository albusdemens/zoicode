import React from 'react';
import { render } from 'ink';
import { Agent, type PermissionMode } from '../agent.js';
import type { LLM } from '../llm.js';
import { listSessions, resolveSession, type Session } from '../sessions.js';
import { App } from './App.js';
import { compactBanner, infoLines, runOpening, type OpeningChoice } from './opening.js';
import { renderBanner, sceneLayout } from './scene.js';
import { paint } from './theme.js';

export interface StartOptions {
  llm: LLM;
  permissionMode: PermissionMode;
  prompt?: string;
  continueLast?: boolean;
  resume?: string | boolean;
  splash?: boolean;
}

/** The banner for the current terminal size: the opening scene, or a compact box if it doesn't fit. */
function makeBanner(model: string, cwd: string, choice: OpeningChoice): string[] {
  const layout = sceneLayout(process.stdout.columns || 80, process.stdout.rows || 24);
  return layout ? renderBanner(layout, infoLines(model, cwd, choice)) : compactBanner(model, cwd);
}

export async function startInteractive(opts: StartOptions) {
  if (!process.stdin.isTTY) {
    console.error('Interactive mode needs a terminal. Use -p for piped input.');
    process.exit(1);
  }
  const cwd = process.cwd();
  const agent = new Agent({ llm: opts.llm, cwd, permissionMode: opts.permissionMode });
  const model = opts.llm.config.model;

  if (opts.resume === true && !opts.continueLast) {
    const all = listSessions(cwd);
    if (!all.length) console.log(paint.dim('No saved sessions here yet; starting fresh.'));
    else {
      console.log(paint.gold('📼 Saved sessions — resume with zoicode -r <id>\n'));
      for (const s of all.slice(0, 15)) {
        console.log(`  ${paint.gold(s.id)}  ${paint.dim(new Date(s.updatedAt).toLocaleString())}  ${s.title || '(untitled)'}`);
      }
      process.exit(0);
    }
  }
  let session: Session | undefined = resolveSession(cwd, !!opts.continueLast, opts.resume === true ? undefined : opts.resume);
  if (!session) {
    console.error(`No session matching "${opts.resume}" in ${cwd}`);
    process.exit(1);
  }

  // Fresh sessions start with the opening scene; resumes go straight in.
  const intro = opts.splash ?? !session.messages.length;
  let choice: OpeningChoice = session.messages.length ? 'continue' : 'new';
  let banner: string[] | undefined;
  if (intro) {
    const opened = await runOpening({ model, cwd, canContinue: listSessions(cwd).length > 0 });
    if (opened) {
      ({ choice, banner } = opened);
      if (choice === 'continue') session = listSessions(cwd)[0] ?? session;
      if (choice === 'plan') agent.permissionMode = 'plan';
      if (choice === 'build') agent.permissionMode = 'acceptEdits';
    }
  }
  agent.messages = session.messages;

  let current = session;
  // Pasted text comes wrapped in markers, so the input box can tell a paste from typing (PromptInput).
  process.stdout.write('\x1b[?2004h');
  process.once('exit', () => process.stdout.write('\x1b[?2004l'));
  const instance = render(
    <App
      agent={agent}
      session={session}
      initialPrompt={opts.prompt || undefined}
      banner={banner ?? makeBanner(model, cwd, choice)}
      makeBanner={() => makeBanner(model, cwd, 'new')}
      greet={intro}
      onSession={s => (current = s)}
    />,
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  const u = agent.totalUsage;
  console.log(
    paint.gold('\n🐾 Bye! ') +
      paint.dim(`Used ${(u.promptTokens + u.completionTokens).toLocaleString()} tokens.`) +
      (current.messages.length ? paint.dim(` Resume with: zoicode -r ${current.id}`) : ''),
  );
  // Nothing should outlive the UI: no orphaned turn, timer or speech bubble keeping the process up.
  process.exit(0);
}
