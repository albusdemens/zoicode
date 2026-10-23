import { Paint } from './canvas.js';
import { catJourney, fidget, JOURNEY_MS } from './catAnim.js';
import { renderBanner, renderScene, sceneLayout, type InfoLine, type Layout, type MenuItem } from './scene.js';
import { logo, sheetGrid } from './sprites/index.js';

export type OpeningChoice = 'new' | 'continue' | 'plan' | 'build';

export function openingMenu(canContinue: boolean): MenuItem[] {
  return [
    { id: 'new', label: 'New Session' },
    ...(canContinue ? [{ id: 'continue', label: 'Continue' }] : []),
    { id: 'plan', label: 'Plan Studio', section: 'Creator Mode' },
    { id: 'build', label: 'Build Studio' },
  ];
}

/** The lines shown where the menu was, once the session has started. */
export function infoLines(model: string, cwd: string, choice: OpeningChoice): InfoLine[] {
  const home = process.env.HOME ?? '';
  const folder = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
  const mode = choice === 'plan' ? '⏸ Plan Studio' : choice === 'build' ? '⏵⏵ Build Studio' : choice === 'continue' ? '↺ Continuing' : '✿ New session';
  return [
    { text: mode, fg: '#F7C548', bold: true },
    { text: model, fg: '#B8F28C' },
    { text: folder, fg: '#F5DEB3' },
    { text: '/help for the almanac', fg: '#E8C9A0' },
  ];
}

/** For terminals too small for the scene: the logo (if it fits) and the session info. */
export function compactBanner(model: string, cwd: string): string[] {
  const cols = Math.min(process.stdout.columns || 80, 100);
  const showLogo = cols >= logo.width + 4;
  const info = infoLines(model, cwd, 'new').slice(1);
  const top = showLogo ? Math.ceil((logo.height + 2) / 2) : 0;
  const p = new Paint(cols, top + info.length + 1);
  if (showLogo) p.blit(sheetGrid(logo, 'main'), 2, 1);
  else p.text(2, 0, 'Zoi Code', { fg: '#7BC043', bold: true });
  info.forEach((l, i) => p.text(2, top + i + (showLogo ? 0 : 1), l.text.slice(0, cols - 4), { fg: l.fg, bold: l.bold }));
  return p.lines();
}

const BSU = '\x1b[?2026h'; // begin synchronized update: the terminal shows the frame all at once
const ESU = '\x1b[?2026l';

/**
 * The opening screen, drawn straight to the terminal (outside Ink) so the full-screen animation
 * only rewrites the lines that change. The cat holds still on the desk, fidgeting now and then,
 * and the little K on the computer spins every few seconds. Enter (or space) picks a menu item:
 * the cat gets up, walks over, hops down and lies on the prompt box. Resolves with the choice
 * and the banner to keep, with the cursor parked at the top-left of the scene, ready for Ink to
 * print the very same banner and prompt over it. Resolves null if the scene doesn't fit.
 */
export function runOpening(opts: { model: string; cwd: string; canContinue: boolean }): Promise<{ choice: OpeningChoice; banner: string[] } | null> {
  const out = process.stdout;
  const stdin = process.stdin;
  let layout: Layout | null = sceneLayout(out.columns || 80, out.rows || 24);
  if (!layout || !stdin.isTTY) return Promise.resolve(null);

  return new Promise(resolve => {
    const items = openingMenu(opts.canContinue);
    let selected = 0;
    let catFrame = 'lie';
    let spinStart: number | null = null;
    let leaving: { start: number; choice: OpeningChoice } | null = null;
    let prev: string[] = [];
    const timers = new Set<NodeJS.Timeout>();
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };

    // The camera pans from the banner down to the prompt while the cat hops there.
    const PAN_DELAY = 200;
    const PAN_MS = 900;
    const panAt = (t: number) => {
      const p = Math.min(1, Math.max(0, (t - PAN_DELAY) / PAN_MS));
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      return layout!.startPan + (layout!.endPan - layout!.startPan) * e;
    };

    const draw = () => {
      const L = layout!;
      const now = Date.now();
      const t = leaving ? now - leaving.start : 0;
      const pose = leaving ? catJourney(t, L.home, L.dest) : null;
      const angle = spinStart === null ? 0 : Math.min(1, (now - spinStart) / 1200) * Math.PI * 2;
      const lines = renderScene(L, leaving
        ? { info: infoLines(opts.model, opts.cwd, leaving.choice), cat: pose, screenAngle: angle, prompt: true, pan: panAt(t) }
        : { menu: { items, selected }, cat: { frame: catFrame, ...L.home }, screenAngle: angle, hint: '↑↓ choose · enter ↵ start', pan: L.startPan });
      let buf = BSU;
      lines.forEach((line, i) => {
        if (line !== prev[i]) buf += `\x1b[${i + 1};1H${line}\x1b[K`;
      });
      out.write(buf + ESU);
      prev = lines;
      return leaving ? t >= Math.max(JOURNEY_MS, PAN_DELAY + PAN_MS) : false;
    };

    let stopFidget = () => {};

    // The K on the screen does a full turn every 6-10 seconds.
    const scheduleSpin = () =>
      later(() => {
        if (leaving) return;
        spinStart = Date.now();
        const tick = () => {
          if (leaving || spinStart === null) return;
          if (Date.now() - spinStart > 1200) {
            spinStart = null;
            draw();
            return scheduleSpin();
          }
          draw();
          later(tick, 60);
        };
        tick();
      }, 6000 + Math.random() * 4000);

    const cleanup = () => {
      stopFidget();
      for (const t of timers) clearTimeout(t);
      stdin.off('data', onKey);
      out.off('resize', onResize);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const walk = () => {
      if (draw()) {
        cleanup();
        out.write('\x1b[1;1H'); // Ink prints the same banner and prompt from here
        resolve({ choice: leaving!.choice, banner: renderBanner(layout!, infoLines(opts.model, opts.cwd, leaving!.choice)) });
        return;
      }
      later(walk, 40);
    };

    const onKey = (data: Buffer) => {
      const key = data.toString('utf8');
      if (key === '\x03') {
        cleanup();
        out.write('\x1b[?25h\x1b[2J\x1b[H');
        process.exit(130);
      }
      if (leaving) return;
      if (key === '\x1b[A' || key === 'k') selected = (selected + items.length - 1) % items.length;
      else if (key === '\x1b[B' || key === 'j' || key === '\t') selected = (selected + 1) % items.length;
      else if (key === '\r' || key === '\n' || key === ' ') {
        leaving = { start: Date.now(), choice: items[selected].id as OpeningChoice };
        return walk();
      } else return;
      draw();
    };

    const onResize = () => {
      layout = sceneLayout(out.columns || 80, out.rows || 24);
      if (!layout) {
        // Too small now: skip the rest of the opening.
        cleanup();
        out.write('\x1b[2J\x1b[H');
        return resolve(null);
      }
      out.write('\x1b[2J');
      prev = [];
      draw();
    };

    // Make room: push whatever is on screen into the scrollback, then draw from the top.
    out.write('\n'.repeat((out.rows || 24) - 1) + '\x1b[?25l');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
    out.on('resize', onResize);
    // fidget() reports the first frame right away, so it starts only now that the screen is ready.
    stopFidget = fidget('idle', f => {
      catFrame = f;
      if (!leaving) draw();
    });
    scheduleSpin();
  });
}
