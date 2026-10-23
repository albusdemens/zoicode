import chalk, { Chalk } from 'chalk';
import type { Grid } from './pixels.js';

// Scenes rendered to a file or pipe (previews, tests) still need their colors; chalk turns them
// off when stdout is not a terminal. NO_COLOR is still respected.
const ink = chalk.level > 0 || process.env.NO_COLOR ? chalk : new Chalk({ level: 3 });

interface TextCell {
  ch: string;
  fg: string;
  bg?: string;
  bold?: boolean;
}

/**
 * A full-frame compositor for terminal pixel art. Pixels are addressed at twice the vertical
 * resolution of text rows and drawn with half blocks; text cells sit on top. `lines()` turns
 * the result into ANSI strings, merging runs of identical style to keep the output small.
 */
export class Paint {
  readonly px: (string | null)[];
  readonly txt: (TextCell | null)[];

  constructor(readonly w: number, readonly h: number) {
    this.px = new Array(w * h * 2).fill(null);
    this.txt = new Array(w * h).fill(null);
  }

  /** A copy, for drawing per-frame details over a cached background. */
  clone(): Paint {
    const p = new Paint(this.w, this.h);
    for (let i = 0; i < this.px.length; i++) p.px[i] = this.px[i];
    for (let i = 0; i < this.txt.length; i++) p.txt[i] = this.txt[i];
    return p;
  }

  pixel(x: number, y: number, c: string | null) {
    x = Math.round(x);
    y = Math.round(y);
    if (x >= 0 && x < this.w && y >= 0 && y < this.h * 2) this.px[y * this.w + x] = c;
  }

  rect(x: number, y: number, w: number, h: number, c: string | null) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.pixel(xx, yy, c);
  }

  /** Draws a pixel grid at (x, y); transparent pixels leave what is below. */
  blit(grid: Grid, x: number, y: number) {
    x = Math.round(x);
    y = Math.round(y);
    grid.forEach((row, gy) => row.forEach((c, gx) => c && this.pixel(x + gx, y + gy, c)));
  }

  /** Writes text at cell (x, row). Characters must be single-width. */
  text(x: number, row: number, s: string, style: { fg: string; bg?: string; bold?: boolean }) {
    let i = 0;
    for (const ch of s) {
      const cx = x + i++;
      if (cx >= 0 && cx < this.w && row >= 0 && row < this.h) this.txt[row * this.w + cx] = { ch, ...style };
    }
  }

  /** Clears text cells in a region (e.g. before redrawing a menu). */
  clearText(x: number, row: number, w: number, h: number) {
    for (let r = row; r < row + h; r++) for (let cx = x; cx < x + w; cx++) if (cx >= 0 && cx < this.w && r >= 0 && r < this.h) this.txt[r * this.w + cx] = null;
  }

  lines(): string[] {
    const out: string[] = [];
    for (let row = 0; row < this.h; row++) {
      let line = '';
      let run = '';
      let key = '';
      let style: ((s: string) => string) | null = null;
      const flush = () => {
        if (run) line += style ? style(run) : run;
        run = '';
      };
      for (let x = 0; x < this.w; x++) {
        const top = this.px[row * 2 * this.w + x];
        const bot = this.px[(row * 2 + 1) * this.w + x];
        const t = this.txt[row * this.w + x];
        let ch: string;
        let fg: string | undefined;
        let bg: string | undefined;
        let bold = false;
        if (t) {
          ch = t.ch;
          fg = t.fg;
          bg = t.bg ?? top ?? bot ?? undefined;
          bold = !!t.bold;
        } else if (!top && !bot) {
          ch = ' ';
        } else if (top === bot) {
          ch = ' ';
          bg = top!;
        } else if (top && !bot) {
          ch = '▀';
          fg = top;
        } else if (!top && bot) {
          ch = '▄';
          fg = bot;
        } else {
          ch = '▀';
          fg = top!;
          bg = bot!;
        }
        const k = `${fg ?? ''}|${bg ?? ''}|${bold ? 1 : 0}`;
        if (k !== key) {
          flush();
          key = k;
          let s = ink as any;
          if (fg) s = s.hex(fg);
          if (bg) s = s.bgHex(bg);
          if (bold) s = s.bold;
          style = fg || bg || bold ? (s as (x: string) => string) : null;
        }
        run += ch;
      }
      flush();
      out.push(line);
    }
    return out;
  }
}

/** Linear blend of two #RRGGBB colors. */
export function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const c = [16, 8, 0].map(s => Math.round(((pa >> s) & 255) + (((pb >> s) & 255) - ((pa >> s) & 255)) * t));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}
