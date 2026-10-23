#!/usr/bin/env python3
"""Render terminal output to a PNG, the way a terminal would show it.

As a script:  termshot.py <file.ans> <out.png> [--cols N] [--rows N] [--light]
              (the .ans file holds ANSI text, e.g. lines printed by the scene renderer)
As a module:  render(screen, out_path) for a pyte screen (test/tui.py uses this for `shot:` steps)

Half blocks (▀ ▄ █) are drawn as exact rectangles so pixel art comes out crisp; other characters
use DejaVu Sans Mono. Characters it lacks (⏺ ⎿ 🐾 …) come from fallback fonts, like a terminal's
font fallback, shrunk to fit their cells; without those fonts they show as boxes. Each cell is
9x18 px, roughly a real terminal's proportions.
"""
import functools
import sys
import pyte
from PIL import Image, ImageDraw, ImageFont

CELL_W, CELL_H = 9, 18
SIZE = 15
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
# For characters DejaVu Sans Mono lacks, tried in order. Wide characters try the emoji font first,
# since terminals show them as color emoji. Fonts that aren't installed are skipped.
FALLBACKS = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',              # ⁘ ⋮
    '/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf',  # ⏺ ⏵ ⏸
    '/usr/share/fonts/truetype/noto/NotoSansSymbols-Regular.ttf',   # ⎿
]
EMOJI = '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf'         # 🐾 📜, a bitmap font made in size 109 only
NAMED = {
    'black': '000000', 'red': 'cd3131', 'green': '0dbc79', 'brown': 'e5e510', 'yellow': 'e5e510',
    'blue': '2472c8', 'magenta': 'bc3fbc', 'cyan': '11a8cd', 'white': 'e5e5e5',
    'brightblack': '666666', 'brightred': 'f14c4c', 'brightgreen': '23d18b', 'brightyellow': 'f5f543',
    'brightblue': '3b8eea', 'brightmagenta': 'd670d6', 'brightcyan': '29b8db', 'brightwhite': 'ffffff',
}


def _rgb(value, default):
    if value in (None, 'default'):
        return default
    hexv = NAMED.get(value, value)
    try:
        return tuple(int(hexv[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return default


@functools.lru_cache(maxsize=None)
def _font(path, size=SIZE):
    """The font, or None if it isn't installed."""
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return None


@functools.lru_cache(maxsize=None)
def _has(font, c):
    """Whether font has a glyph for c. Fonts draw characters they lack as their "missing" glyph,
    the same one they draw for an unassigned private-use character."""
    mask, missing = font.getmask(c), font.getmask('\U0010FFFD')
    return mask.size != missing.size or bytes(mask) != bytes(missing)


@functools.lru_cache(maxsize=None)
def _fallback(c, wide):
    """The installed fallback font to draw c with, or None."""
    fonts = [_font(path) for path in FALLBACKS]
    fonts = [_font(EMOJI, 109)] + fonts if wide else fonts + [_font(EMOJI, 109)]
    return next((f for f in fonts if f and _has(f, c)), None)


@functools.lru_cache(maxsize=None)
def _glyph(font, c, w, h):
    """c in font, cropped to its ink and shrunk to fit w x h if needed (RGBA, in color for emoji),
    and where the ink's center sits relative to the baseline (negative is above it)."""
    left, top, right, bottom = font.getbbox(c, anchor='ls')
    im = Image.new('RGBA', (right - left + 4, bottom - top + 4), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((2 - left, 2 - top), c, font=font, fill='white', anchor='ls', embedded_color=True)
    ink = im.getbbox() or (0, 0, 1, 1)
    im = im.crop(ink)
    scale = min(1, w / im.width, h / im.height)
    if scale < 1:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    return im, (ink[1] + ink[3]) / 2 - (2 - top)


def _draw_fallback(img, font, c, x0, y0, baseline, wide, fg):
    """Draws c from a fallback font, centered in its cell (or two, for a wide character)."""
    box_w = CELL_W * (2 if wide else 1)
    if font is _font(EMOJI, 109):
        glyph, _ = _glyph(font, c, box_w - 2, SIZE)
        img.paste(glyph, (x0 + (box_w - glyph.width) // 2, y0 + (CELL_H - glyph.height) // 2), glyph)
    else:
        # Centered on the same height as it would be on the baseline, so it lines up with the text.
        glyph, middle = _glyph(font, c, box_w, CELL_H)
        top = round(y0 + baseline + middle - glyph.height / 2)
        img.paste(fg, (x0 + (box_w - glyph.width) // 2, top), glyph.getchannel('A'))


def render(screen, out_path, light=False):
    fg_default = (40, 40, 40) if light else (208, 208, 208)
    bg_default = (250, 250, 250) if light else (30, 30, 30)
    img = Image.new('RGB', (screen.columns * CELL_W, screen.lines * CELL_H), bg_default)
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, SIZE)
    bold = ImageFont.truetype(FONT_BOLD, SIZE)
    baseline = 1 + font.getmetrics()[0]
    glyphs = []
    # Pass 1: cell backgrounds and block characters. Pass 2: text, so glyphs that reach below their
    # cell (underscores, descenders) are not painted over by the next row's background.
    for y in range(screen.lines):
        row = screen.buffer[y]
        for x in range(screen.columns):
            ch = row[x]
            fg = _rgb(ch.fg, fg_default)
            bg = _rgb(ch.bg, bg_default)
            if ch.reverse:
                fg, bg = bg, fg
            x0, y0 = x * CELL_W, y * CELL_H
            box = (x0, y0, x0 + CELL_W - 1, y0 + CELL_H - 1)
            half = y0 + CELL_H // 2
            c = ch.data
            if c == '▀':
                draw.rectangle(box, fill=bg)
                draw.rectangle((x0, y0, x0 + CELL_W - 1, half - 1), fill=fg)
            elif c == '▄':
                draw.rectangle(box, fill=bg)
                draw.rectangle((x0, half, x0 + CELL_W - 1, y0 + CELL_H - 1), fill=fg)
            elif c == '█':
                draw.rectangle(box, fill=fg)
            else:
                draw.rectangle(box, fill=bg)
                if c and c != ' ':
                    # pyte leaves an empty cell after a wide character (an emoji, say).
                    wide = x + 1 < screen.columns and row[x + 1].data == ''
                    glyphs.append((x0, y0, c, bold if ch.bold else font, fg, wide))
    for x0, y0, c, f, fg, wide in glyphs:
        fallback = None if _has(f, c) else _fallback(c, wide)
        if fallback:
            _draw_fallback(img, fallback, c, x0, y0, baseline, wide, fg)
        else:
            draw.text((x0, y0 + 1), c, font=f, fill=fg)
    img.save(out_path)
    return out_path


def render_ansi(text, out_path, cols=120, rows=None, light=False):
    lines = text.rstrip('\n').split('\n')
    rows = rows or len(lines)
    screen = pyte.Screen(cols, rows)
    stream = pyte.Stream(screen)
    stream.feed('\r\n'.join(lines))
    return render(screen, out_path, light)


if __name__ == '__main__':
    args = sys.argv[1:]
    opts = {'--cols': None, '--rows': None}
    for k in list(opts):
        if k in args:
            i = args.index(k)
            opts[k] = int(args[i + 1])
            del args[i:i + 2]
    light = '--light' in args
    args = [a for a in args if a != '--light']
    src, out = args[0], args[1]
    text = open(src, encoding='utf-8').read()
    cols = opts['--cols'] or max(len(l) for l in text.split('\n'))
    print(render_ansi(text, out, cols, opts['--rows'], light))
