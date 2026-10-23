/**
 * Validate sprite sheets and render them to a PNG for review.
 *
 *   npx tsx scripts/sprite-preview.ts <cat|logo|computer|all> --out file.png [--scale N] [--cols N]
 *
 * Frames are drawn magnified with a faint pixel grid on three backgrounds: a dark terminal, a light
 * terminal, and the opening scene's wooden wall. Near-actual-size copies follow each band.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SHEET_SPECS, sheetGrid, validateSheet, type SpriteSheet } from '../src/ui/sprites/index.js';
import { Canvas, encodePng, hex, type RGB } from './png.js';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a, i) => !a.startsWith('--') && !['--out', '--scale', '--cols'].includes(args[i - 1])) ?? 'all';
const names = target === 'all' ? Object.keys(SHEET_SPECS) : [target];

let invalid = false;
for (const n of names) {
  const spec = SHEET_SPECS[n];
  if (!spec) {
    console.error(`Unknown sheet "${n}". Known: ${Object.keys(SHEET_SPECS).join(', ')}`);
    process.exit(2);
  }
  const errors = validateSheet(spec.sheet, spec.required, spec.variants);
  if (errors.length) {
    invalid = true;
    console.log(`✗ ${n}\n  - ${errors.slice(0, 40).join('\n  - ')}${errors.length > 40 ? `\n  … ${errors.length - 40} more` : ''}`);
  } else {
    console.log(`✓ ${n} is valid (${Object.keys(spec.sheet.frames).length} frames, ${spec.sheet.width}x${spec.sheet.height})`);
  }
}

const BANDS: { bg: RGB; canvas: RGB; grid: RGB; label: string }[] = [
  { label: 'dark terminal', bg: hex('#1E1E1E'), canvas: hex('#262626'), grid: hex('#303030') },
  { label: 'light terminal', bg: hex('#FAFAFA'), canvas: hex('#F0F0F0'), grid: hex('#E3E3E3') },
  { label: 'scene wall', bg: hex('#9C5B2E'), canvas: hex('#C9783A'), grid: hex('#BE6F33') }, // the desk and wall planks of ROOM in src/ui/scene.ts
];

function drawFrame(cv: Canvas, sheet: SpriteSheet, frame: string, x0: number, y0: number, s: number, band: (typeof BANDS)[number]) {
  const grid = sheetGrid(sheet, frame);
  cv.rect(x0, y0, sheet.width * s, sheet.height * s, band.canvas);
  if (s >= 6) {
    for (let x = 0; x <= sheet.width; x++) cv.rect(x0 + x * s, y0, 1, sheet.height * s, band.grid);
    for (let y = 0; y <= sheet.height; y++) cv.rect(x0, y0 + y * s, sheet.width * s, 1, band.grid);
  }
  grid.forEach((row, y) => row.forEach((c, x) => c && cv.rect(x0 + x * s, y0 + y * s, s, s, hex(c))));
}

const out = opt('--out');
if (out) {
  // One sheet per PNG band group; with "all", sheets are stacked.
  const sheets = names.map(n => SHEET_SPECS[n].sheet);
  const scale = Number(opt('--scale') ?? 8);
  const small = 3;
  const gap = 12;
  const layouts = sheets.map(sheet => {
    const frames = Object.keys(sheet.frames);
    const perRow = Math.max(1, Math.min(frames.length, Number(opt('--cols') ?? Math.max(1, Math.floor(1500 / (sheet.width * scale + gap))))));
    const rowsOfFrames = Math.ceil(frames.length / perRow);
    const bandW = gap + perRow * (sheet.width * scale + gap);
    const smallH = sheet.height * small + gap;
    const bandH = gap + rowsOfFrames * (sheet.height * scale + gap) + smallH;
    return { sheet, frames, perRow, bandW, bandH };
  });
  const width = Math.max(...layouts.map(l => l.bandW), 200);
  const height = layouts.reduce((sum, l) => sum + l.bandH * BANDS.length, 0);
  const cv = new Canvas(width, height, BANDS[0].bg);
  let y = 0;
  for (const l of layouts) {
    for (const band of BANDS) {
      cv.rect(0, y, width, l.bandH, band.bg);
      l.frames.forEach((f, i) => {
        const col = i % l.perRow;
        const row = Math.floor(i / l.perRow);
        drawFrame(cv, l.sheet, f, gap + col * (l.sheet.width * scale + gap), y + gap + row * (l.sheet.height * scale + gap), scale, band);
      });
      // Near-actual size, all frames in a row.
      const sy = y + gap + Math.ceil(l.frames.length / l.perRow) * (l.sheet.height * scale + gap);
      l.frames.forEach((f, i) => drawFrame(cv, l.sheet, f, gap + i * (l.sheet.width * small + 6), sy, small, band));
      y += l.bandH;
    }
    console.log(`${l.sheet.name}: frames in order: ${l.frames.join(', ')}`);
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, encodePng(cv));
  console.log(`Wrote ${out} (${cv.w}x${cv.h})`);
}

process.exit(invalid ? 1 : 0);
