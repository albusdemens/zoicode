/**
 * Render frames of the opening scene to PNG through the terminal renderer (test/termshot.py).
 *
 *   npx tsx scripts/scene-preview.ts --out dir [--cols 120] [--rows 46] [--light]
 *
 * Writes opening.png (menu, cat on the desk), hop-NNNN.png (moments of the trip to the prompt
 * box) and banner.png (what stays in the scrollback afterwards).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { catJourney } from '../src/ui/catAnim.js';
import { infoLines, openingMenu } from '../src/ui/opening.js';
import { renderBanner, renderScene, sceneLayout } from '../src/ui/scene.js';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const out = opt('--out', '.');
const cols = Number(opt('--cols', '120'));
const rows = Number(opt('--rows', '46'));
const L = sceneLayout(cols, rows);
if (!L) {
  console.error(`The scene does not fit ${cols}x${rows}.`);
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
const termshot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'test', 'termshot.py');

function shot(name: string, lines: string[], height = rows) {
  const ans = path.join(out, `${name}.ans`);
  fs.writeFileSync(ans, lines.join('\n'));
  const png = path.join(out, `${name}.png`);
  execFileSync('python3', [termshot, ans, png, '--cols', String(cols), '--rows', String(height), ...(args.includes('--light') ? ['--light'] : [])]);
  console.log(png);
}

const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const panAt = (t: number) => L.startPan + (L.endPan - L.startPan) * ease(Math.min(1, Math.max(0, (t - 200) / 900)));

shot('opening', renderScene(L, { menu: { items: openingMenu(true), selected: 0 }, cat: { frame: 'open', ...L.home }, hint: '↑↓ choose · enter ↵ start', pan: L.startPan }));
const info = infoLines('raon-1-mini-preview', process.cwd(), 'new');
for (const t of [300, 700, 1000, 1300, 1800]) {
  shot(`hop-${String(t).padStart(4, '0')}`, renderScene(L, { info, cat: catJourney(t, L.home, L.dest), prompt: true, pan: panAt(t) }));
}
shot('banner', renderBanner(L, info), L.bannerRows);
