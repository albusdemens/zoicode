import { mix, Paint } from './canvas.js';
import { CAT_H, CAT_W, cat, computer, keyRect, logo, sheetGrid } from './sprites/index.js';

/** Rows of the live area under the banner: the cat, the prompt box and the status line. */
export const PET_ROWS = CAT_H / 2;
export const PROMPT_ROWS = 3;
export const LIVE_ROWS = PET_ROWS + PROMPT_ROWS + 1;
/** The cat sits this many columns in from the right edge (the App uses the same margin). */
export const PET_MARGIN = 2;

/**
 * The scene is a "world" taller than the screen: the banner (logo, menu, desk with the computer
 * and the cat) on top, and the live area (cat on the prompt box) below it. The opening shows the
 * banner; after Enter the view pans down to the prompt while the cat hops there. The App then
 * prints the very same banner and live area, so the scrollback keeps the logo above.
 */
export interface Layout {
  cols: number;
  rows: number;
  /** Lines drawn on screen (rows - 1). */
  view: number;
  /** World rows of the painted banner; the live area follows. */
  bannerRows: number;
  worldRows: number;
  /** First world row on screen before Enter and once the cat has landed. */
  startPan: number;
  endPan: number;
  /** Pixel row of the desk top. */
  deskTop: number;
  /** Pixel positions (top-left) in world space. */
  home: { x: number; y: number };
  dest: { x: number; y: number };
  comp: { x: number; y: number };
  logo: { x: number; y: number };
  /** Text cell where the menu (or the info lines) start, and how wide that column is. */
  menu: { col: number; row: number; width: number };
  screen: { x: number; y: number; w: number; h: number };
}

const TITLE_ROWS = logo.height / 2 + 2;
const MENU_WIDTH = 22;

/** Where everything goes for a terminal size, or null if the scene doesn't fit. */
export function sceneLayout(cols: number, rows: number): Layout | null {
  const view = rows - 1;
  const deskTop = (TITLE_ROWS + 1 + PET_ROWS) * 2;
  const bannerRows = deskTop / 2 + 4;
  // The logo is the widest thing; the whole banner has to be visible before Enter.
  if (cols < logo.width + 4 || view < bannerRows + 1) return null;
  const home = { x: cols - CAT_W - Math.max(6, Math.floor((cols - logo.width) / 2) + 4), y: deskTop + 2 - CAT_H };
  const comp = { x: Math.max(MENU_WIDTH + 8, home.x - computer.width - 10), y: deskTop + 4 - computer.height };
  const s = keyRect(computer, 'main', 'S') ?? { x: 4, y: 3, w: 26, h: 12 };
  const worldRows = bannerRows + LIVE_ROWS;
  return {
    cols, rows, view, bannerRows, worldRows,
    startPan: 0,
    endPan: Math.max(0, worldRows - view),
    deskTop,
    home,
    dest: { x: cols - CAT_W - PET_MARGIN, y: bannerRows * 2 },
    comp,
    logo: { x: Math.floor((cols - logo.width) / 2), y: 2 },
    menu: { col: 4, row: TITLE_ROWS + 2, width: MENU_WIDTH },
    screen: { x: comp.x + s.x, y: comp.y + s.y, w: s.w, h: s.h },
  };
}

// ---- the room ----------------------------------------------------------------

/** Deterministic pseudo-random numbers, so the banner looks the same on every frame. */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const ROOM = {
  plank: ['#C9783A', '#BE6F33', '#D3843F'],
  seam: '#7A3F1C',
  nail: '#5C2E17',
  deskEdge: '#E39A55',
  deskTop: '#C47A3F',
  desk: '#9C5B2E',
  deskDark: '#5E3218',
};

/** The wall (wooden planks with the odd nail) and the desk. */
function paintRoom(p: Paint, L: Layout) {
  const rand = seeded(7);
  const h = L.bannerRows * 2;
  for (let y = 0; y < L.deskTop; y++) {
    const color = y % 4 === 3 ? ROOM.seam : ROOM.plank[Math.floor(y / 4) % ROOM.plank.length];
    p.rect(0, y, L.cols, 1, color);
  }
  for (let i = 0; i < L.cols / 6; i++) p.pixel(Math.floor(rand() * L.cols), Math.floor(rand() * (L.deskTop / 4)) * 4 + 1, ROOM.nail);
  p.rect(0, L.deskTop, L.cols, 1, ROOM.deskEdge);
  p.rect(0, L.deskTop + 1, L.cols, 3, ROOM.deskTop);
  p.rect(0, L.deskTop + 4, L.cols, h - L.deskTop - 5, ROOM.desk);
  p.rect(0, h - 1, L.cols, 1, ROOM.deskDark);
}

const roomCache = new Map<string, Paint>();

/** The static part of the world for a layout: room, computer and logo. */
function background(L: Layout): Paint {
  const key = `${L.cols}x${L.rows}`;
  let p = roomCache.get(key);
  if (!p) {
    p = new Paint(L.cols, L.worldRows);
    paintRoom(p, L);
    p.blit(sheetGrid(computer, 'main'), L.comp.x, L.comp.y);
    p.blit(sheetGrid(logo, 'main'), L.logo.x, L.logo.y);
    roomCache.set(key, p);
  }
  return p;
}

// ---- the computer screen -------------------------------------------------------

const MINI_K = ['##....##', '##...##.', '##..##..', '##.##...', '####....', '####....', '##.##...', '##..##..', '##...##.', '##....##'];

/** The screen: a soft glow with a little Krafton K that spins now and then (angle 0 = at rest). */
function paintScreen(p: Paint, L: Layout, angle: number) {
  const { x, y, w, h } = L.screen;
  for (let yy = 0; yy < h; yy++) p.rect(x, y + yy, w, 1, mix('#2F5A3A', '#1F3B28', yy / h));
  const kw = MINI_K[0].length;
  const kh = MINI_K.length;
  const cos = Math.cos(angle);
  const cx = x + w / 2;
  const top = y + Math.round((h - kh) / 2);
  for (let ky = 0; ky < kh; ky++) {
    for (let kx = 0; kx < kw; kx++) {
      if (MINI_K[ky][kx] !== '#') continue;
      const px = cx + (kx - kw / 2 + 0.5) * cos;
      p.pixel(Math.floor(px), top + ky, cos >= 0 ? mix('#B8F28C', '#7BC043', ky / kh) : mix('#7BC043', '#4E8A2A', ky / kh));
    }
  }
  if (Math.abs(cos) < 0.25) p.rect(Math.round(cx) - 1, top, 1, kh, '#4E8A2A');
}

// ---- text: menu, info, hint, prompt -----------------------------------------------

export interface MenuItem {
  id: string;
  label: string;
  /** A small heading shown above this item. */
  section?: string;
}

export interface InfoLine {
  text: string;
  fg: string;
  bold?: boolean;
}

const MENU = { plank: '#E8B565', plankSel: '#F7D27A', text: '#4A2A12', textSel: '#3B1F0A', shadow: '#7A3F1C', section: '#FBE8B5' };

function paintMenu(p: Paint, L: Layout, items: MenuItem[], selected: number) {
  let row = L.menu.row;
  const lastRow = Math.floor(L.deskTop / 2) - 1;
  const gap = items.length * 2 + items.filter(i => i.section).length <= lastRow - row ? 1 : 0;
  items.forEach((item, i) => {
    if (item.section) p.text(L.menu.col + 1, row++, item.section, { fg: MENU.section, bold: true });
    const sel = i === selected;
    const w = L.menu.width - 2;
    // A wooden sign: plank-colored text row with a shadow along its bottom edge.
    p.rect(L.menu.col, row * 2, w, 2, sel ? MENU.plankSel : MENU.plank);
    p.rect(L.menu.col + 1, row * 2 + 2, w, 1, MENU.shadow);
    p.text(L.menu.col + 1, row, `${sel ? '▶ ' : '  '}${item.label}`.padEnd(w - 2), { fg: sel ? MENU.textSel : MENU.text, bold: sel });
    row += 1 + gap;
  });
}

function paintInfo(p: Paint, L: Layout, lines: InfoLine[]) {
  lines.forEach((l, i) => {
    const text = l.text.length > L.menu.width + 6 ? '…' + l.text.slice(-(L.menu.width + 5)) : l.text;
    p.text(L.menu.col, L.menu.row + i, ` ${text} `, { fg: l.fg, bold: l.bold, bg: '#5E3218' });
  });
}

const PROMPT = { border: '#C08040', glyph: '#F7C548', placeholder: '#8C7A6B', status: '#8C7A6B' };

/** The prompt box and status line, drawn the way PromptInput renders them, for the last frames of the opening. */
function paintPrompt(p: Paint, L: Layout) {
  const top = L.bannerRows + PET_ROWS;
  const w = L.cols;
  p.text(0, top, '╭' + '─'.repeat(w - 2) + '╮', { fg: PROMPT.border });
  p.text(0, top + 1, '│', { fg: PROMPT.border });
  p.text(w - 1, top + 1, '│', { fg: PROMPT.border });
  p.text(2, top + 1, '›', { fg: PROMPT.glyph, bold: true });
  p.text(5, top + 1, 'Type a request… (/ for commands, @ to mention files)', { fg: PROMPT.placeholder });
  p.text(0, top + 2, '╰' + '─'.repeat(w - 2) + '╯', { fg: PROMPT.border });
  p.text(2, top + 3, '? /help for commands', { fg: PROMPT.status });
}

// ---- putting it together ---------------------------------------------------------

export interface SceneState {
  menu?: { items: MenuItem[]; selected: number };
  info?: InfoLine[];
  /** The cat in world pixels, or null for none. */
  cat?: { frame: string; x: number; y: number } | null;
  screenAngle?: number;
  /** Show the prompt box and status line under the banner. */
  prompt?: boolean;
  /** A hint on the last screen line (an overlay, not part of the world). */
  hint?: string;
  /** First world row on screen. */
  pan?: number;
}

function paintWorld(L: Layout, s: SceneState): Paint {
  const p = background(L).clone();
  paintScreen(p, L, s.screenAngle ?? 0);
  if (s.menu) paintMenu(p, L, s.menu.items, s.menu.selected);
  if (s.info) paintInfo(p, L, s.info);
  if (s.prompt) paintPrompt(p, L);
  if (s.cat) p.blit(sheetGrid(cat, s.cat.frame), s.cat.x, s.cat.y);
  return p;
}

/** One frame of the opening screen: the `view` lines of the world starting at `pan`. */
export function renderScene(L: Layout, s: SceneState): string[] {
  const p = paintWorld(L, s);
  const pan = Math.round(s.pan ?? L.startPan);
  if (s.hint) {
    const row = pan + L.view - 1;
    p.clearText(0, row, L.cols, 1);
    p.text(Math.max(0, Math.floor((L.cols - s.hint.length) / 2)), row, s.hint, { fg: '#F5DEB3', bold: true });
  }
  return p.lines().slice(pan, pan + L.view);
}

/** The banner the App keeps at the top of the scrollback: the world above the live area, without the cat. */
export function renderBanner(L: Layout, info: InfoLine[]): string[] {
  return paintWorld(L, { info, cat: null }).lines().slice(0, L.bannerRows);
}
