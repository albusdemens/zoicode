import chalk from 'chalk';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { highlight, supportsLanguage } from 'cli-highlight';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { sanitize } from './sanitize.js';
import { C, paint } from './theme.js';

let cachedWidth = 0;
let marked: Marked;

function getMarked(width: number): Marked {
  if (marked && width === cachedWidth) return marked;
  cachedWidth = width;
  marked = new Marked();
  marked.use(
    markedTerminal(
      {
        width,
        reflowText: false,
        tab: 2,
        showSectionPrefix: false,
        heading: chalk.hex(C.gold).bold,
        firstHeading: chalk.hex(C.gold).bold.underline,
        strong: chalk.bold.hex(C.parchment),
        em: chalk.italic,
        codespan: chalk.hex(C.goldLight),
        code: (code: string) => code,
        blockquote: chalk.hex(C.dim).italic,
        link: chalk.hex(C.sky),
        href: chalk.hex(C.sky).underline,
        listitem: (s: string) => s,
        hr: chalk.hex(C.wood),
        table: chalk.reset,
        paragraph: chalk.reset,
        html: chalk.hex(C.dim),
        del: chalk.dim.strikethrough,
        emoji: true,
      },
      { theme: {} },
    ) as any,
  );
  // Our own fenced-code renderer: syntax highlight inside a wooden gutter.
  marked.use({
    renderer: {
      code({ text, lang }: { text: string; lang?: string }) {
        // Only highlight a known, labeled language: auto-detection tries every grammar, and
        // re-running it on each streaming frame freezes the UI on long code blocks.
        const language = (lang ?? '').trim().split(/\s+/)[0];
        let body = sanitize(text);
        if (language && supportsLanguage(language)) {
          try {
            body = highlight(body, { language, ignoreIllegals: true });
          } catch { /* grammar error */ }
        }
        const gutter = paint.wood('│ ');
        const header = lang ? paint.wood('╭─ ') + paint.dim(sanitize(lang)) + '\n' : paint.wood('╭─') + '\n';
        // Leading newline: inside list items the code would otherwise run on from the item text.
        return '\n' + header + body.split('\n').map(l => gutter + l).join('\n') + '\n' + paint.wood('╰─') + '\n\n';
      },
    },
  });
  return marked;
}

export function renderMarkdown(text: string, width = process.stdout.columns || 80): string {
  try {
    const out = getMarked(Math.max(40, width - 4)).parse(text, { async: false }) as string;
    return out.replace(/\n+$/, '');
  } catch {
    return text;
  }
}

/** Colored unified diff: green for additions, red for removals, with line numbers. */
export function renderDiff(patch: string, maxLines = 40): string {
  const out: string[] = [];
  let oldLn = 0;
  let newLn = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (hunk) {
      if (out.length) out.push(paint.dim('   ⋮'));
      oldLn = Number(hunk[1]);
      newLn = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    // Index:/===/---/+++ headers only come before the first hunk; inside one, "---" is a removed "--" line.
    if (!inHunk || raw.startsWith('\\')) continue;
    const line = sanitize(raw);
    if (line.startsWith('+')) {
      out.push(chalk.bgHex('#1F3A1A').hex('#B8F28C')(`${String(newLn++).padStart(4)} + ${line.slice(1)}`));
    } else if (line.startsWith('-')) {
      out.push(chalk.bgHex('#3F1A20').hex('#F7A1B0')(`${String(oldLn++).padStart(4)} - ${line.slice(1)}`));
    } else if (line.startsWith(' ')) {
      out.push(paint.dim(`${String(newLn).padStart(4)}   `) + line.slice(1));
      oldLn++;
      newLn++;
    }
  }
  if (out.length > maxLines) {
    return [...out.slice(0, maxLines), paint.dim(`   … +${out.length - maxLines} more lines`)].join('\n');
  }
  return out.join('\n');
}

/**
 * Wraps text to `width` columns and puts `bullet` before the first line (and matching indentation
 * before the rest). Ink is handed finished lines it never has to wrap: its own wrapping of text
 * next to a bullet can come out one column too wide, which the terminal then breaks again.
 */
export function bulleted(text: string, bullet: string, width: number): string {
  const indent = ' '.repeat(stringWidth(bullet));
  return wrapAnsi(text, Math.max(10, width - indent.length), { hard: true, trim: false })
    .split('\n')
    .map((line, i) => (i === 0 ? bullet : indent) + line.replace(/ +$/, ''))
    .join('\n');
}
