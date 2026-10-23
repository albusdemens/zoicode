import chalk from 'chalk';

/** A pixel grid of hex colors; null is transparent. */
export type Grid = (string | null)[][];

/** Renders a pixel grid with half blocks: one character cell holds two vertical pixels. */
export function renderGrid(grid: Grid): string[] {
  const lines: string[] = [];
  const width = Math.max(...grid.map(r => r.length));
  for (let y = 0; y < grid.length; y += 2) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const top = grid[y]?.[x] ?? null;
      const bot = grid[y + 1]?.[x] ?? null;
      if (!top && !bot) line += ' ';
      else if (top && !bot) line += chalk.hex(top)('▀');
      else if (!top && bot) line += chalk.hex(bot)('▄');
      else if (top === bot) line += chalk.hex(top!)('█');
      else line += chalk.hex(top!).bgHex(bot!)('▀');
    }
    lines.push(line);
  }
  return lines;
}
