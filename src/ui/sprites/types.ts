import type { Grid } from '../pixels.js';

/**
 * Pixel art with named frames that all share one canvas size. Each frame is a list of
 * rows, one character per pixel: '.' is transparent, anything else is a palette key.
 * Terminals draw two pixel rows per text row (half blocks), so pixels come out about square.
 */
export interface SpriteSheet {
  name: string;
  width: number;
  height: number;
  palette: Record<string, string>;
  frames: Record<string, string[]>;
}

export function sheetGrid(sheet: SpriteSheet, frame: string): Grid {
  const rows = sheet.frames[frame] ?? sheet.frames[Object.keys(sheet.frames)[0]];
  return rows.map(r => [...r].map(ch => (ch === '.' ? null : sheet.palette[ch] ?? null)));
}

/** Pixels that differ between two frames. */
export function frameDiff(a: string[], b: string[]): number {
  let n = 0;
  a.forEach((r, y) => [...r].forEach((ch, x) => (n += ch === b[y]?.[x] ? 0 : 1)));
  return n;
}

/**
 * Checks sizes, palette keys and required frames. `variants` maps a frame to the base frame it
 * must stay close to (at most `max` changed pixels), so idle animations don't make the body jump.
 */
export function validateSheet(
  sheet: SpriteSheet,
  required: string[],
  variants: Record<string, { base: string; max: number }> = {},
): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(sheet.palette)) {
    if ([...k].length !== 1 || k === '.') errors.push(`palette key "${k}" must be a single character other than "."`);
    if (!/^#[0-9A-Fa-f]{6}$/.test(v)) errors.push(`palette color ${k}=${v} must be #RRGGBB`);
  }
  for (const f of required) if (!sheet.frames[f]) errors.push(`missing frame "${f}"`);
  for (const [name, rows] of Object.entries(sheet.frames)) {
    if (rows.length !== sheet.height) errors.push(`${name}: has ${rows.length} rows, needs ${sheet.height}`);
    rows.forEach((r, y) => {
      if ([...r].length !== sheet.width) errors.push(`${name} row ${y}: has ${[...r].length} columns, needs ${sheet.width}`);
      for (const ch of r) if (ch !== '.' && !sheet.palette[ch]) errors.push(`${name} row ${y}: unknown palette key "${ch}"`);
    });
  }
  for (const [name, { base, max }] of Object.entries(variants)) {
    const a = sheet.frames[base];
    const b = sheet.frames[name];
    if (!a || !b) continue;
    const n = frameDiff(a, b);
    if (n === 0) errors.push(`${name} is identical to ${base}`);
    if (n > max) errors.push(`${name} differs from ${base} in ${n} pixels (max ${max}); keep the body still and change only the animated part`);
  }
  return errors;
}

/** Bounding box of pixels with the given palette key (e.g. a monitor's screen area). */
export function keyRect(sheet: SpriteSheet, frame: string, key: string) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  sheet.frames[frame]?.forEach((r, y) =>
    [...r].forEach((ch, x) => {
      if (ch !== key) return;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }),
  );
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
