/**
 * Which image protocols does this terminal support? Run it in the terminal you use:
 *
 *   npx tsx scripts/graphics-check.ts
 *
 * Asks the terminal (Kitty graphics query, primary device attributes for Sixel), reports the
 * answers, and draws the cat with every protocol that is available, plus the half-block fallback.
 */
import fs from 'node:fs';
import path from 'node:path';
import { renderGrid } from '../src/ui/pixels.js';
import { cat, sheetGrid } from '../src/ui/sprites/index.js';

const out = process.stdout;
const stdin = process.stdin;
if (!stdin.isTTY) {
  console.error('Run this directly in a terminal.');
  process.exit(1);
}

/** Sends queries and collects whatever the terminal answers within `ms`. */
function ask(query: string, ms = 600): Promise<string> {
  return new Promise(resolve => {
    let reply = '';
    const onData = (d: Buffer) => (reply += d.toString('latin1'));
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    out.write(query);
    setTimeout(() => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(reply);
    }, ms);
  });
}

/** Minimal Sixel encoder for a pixel grid (scaled up), one color register per palette color. */
function sixel(grid: (string | null)[][], scale: number): string {
  const h = grid.length * scale;
  const w = grid[0].length * scale;
  const px = (x: number, y: number) => grid[Math.floor(y / scale)][Math.floor(x / scale)];
  const colors = [...new Set(grid.flat().filter((c): c is string => !!c))];
  let s = `\x1bP0;1;0q"1;1;${w};${h}`;
  colors.forEach((c, i) => {
    const [r, g, b] = [1, 3, 5].map(k => Math.round((parseInt(c.slice(k, k + 2), 16) * 100) / 255));
    s += `#${i};2;${r};${g};${b}`;
  });
  for (let band = 0; band < h; band += 6) {
    colors.forEach((c, i) => {
      let line = '';
      let used = false;
      for (let x = 0; x < w; x++) {
        let bits = 0;
        for (let k = 0; k < 6 && band + k < h; k++) if (px(x, band + k) === c) bits |= 1 << k;
        if (bits) used = true;
        line += String.fromCharCode(63 + bits);
      }
      if (used) s += `#${i}${line.replace(/(.)\1{3,}/g, (m, ch) => `!${m.length}${ch}`)}$`;
    });
    s += '-';
  }
  return s + '\x1b\\';
}

const kittyReply = await ask('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\\x1b[c');
const kitty = /\x1b_Gi=31;OK/.test(kittyReply);
const da1 = kittyReply.match(/\x1b\[\?([\d;]+)c/)?.[1]?.split(';') ?? [];
const sixelOk = da1.includes('4');
const iterm = ['iTerm.app', 'WezTerm', 'vscode'].includes(process.env.TERM_PROGRAM ?? '');

console.log(`\nTerminal: ${process.env.TERM_PROGRAM ?? (process.env.VTE_VERSION ? `VTE ${process.env.VTE_VERSION}` : process.env.TERM)}`);
console.log(`  Kitty graphics:  ${kitty ? 'yes' : 'no'}`);
console.log(`  Sixel:           ${sixelOk ? 'yes' : 'no'}   (device attributes: ${da1.join(';') || 'no answer'})`);
console.log(`  iTerm2 images:   ${iterm ? 'probably' : 'no'}\n`);

const png = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'art', 'cat-open.png'));
if (kitty) {
  console.log('Kitty graphics, the original image in 14 columns:');
  const b64 = png.toString('base64');
  for (let i = 0; i < b64.length; i += 4096) {
    const more = i + 4096 < b64.length ? 1 : 0;
    out.write(i === 0 ? `\x1b_Ga=T,f=100,c=14,m=${more};${b64.slice(i, i + 4096)}\x1b\\` : `\x1b_Gm=${more};${b64.slice(i, i + 4096)}\x1b\\`);
  }
  console.log('\n');
}
if (iterm) {
  console.log('iTerm2 inline image, 14 columns:');
  out.write(`\x1b]1337;File=inline=1;width=14;preserveAspectRatio=1:${png.toString('base64')}\x07\n\n`);
}
if (sixelOk) {
  console.log('Sixel, the pixel-art cat at 4x:');
  out.write(sixel(sheetGrid(cat, 'open'), 4) + '\n\n');
}
console.log('Half blocks (works everywhere):');
for (const line of renderGrid(sheetGrid(cat, 'open'))) console.log(line);
process.exit(0);
