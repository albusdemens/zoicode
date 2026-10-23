import { cat } from './cat.js';
import { computer } from './computer.js';
import { logo } from './logo.js';
import { validateSheet, type SpriteSheet } from './types.js';

export { cat, computer, logo };
export * from './types.js';

/** Size of the cat in pixels (two pixel rows per text row). */
export const CAT_W = cat.width;
export const CAT_H = cat.height;

/** Frame requirements per sheet: required frames, and how far variants may stray from their base. */
export const SHEET_SPECS: Record<string, { sheet: SpriteSheet; required: string[]; variants?: Record<string, { base: string; max: number }> }> = {
  cat: {
    sheet: cat,
    required: ['open', 'twitch', 'half', 'closed'],
    variants: {
      twitch: { base: 'open', max: 60 },
      half: { base: 'open', max: 40 },
      closed: { base: 'open', max: 40 },
    },
  },
  computer: { sheet: computer, required: ['main'] },
  logo: { sheet: logo, required: ['main'] },
};

export function validateAll(): Record<string, string[]> {
  return Object.fromEntries(Object.entries(SHEET_SPECS).map(([k, s]) => [k, validateSheet(s.sheet, s.required, s.variants)]));
}
