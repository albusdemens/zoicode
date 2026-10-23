#!/usr/bin/env python3
"""Render terminal output to a PNG, the way a terminal would show it.

As a script:  termshot.py <file.ans> <out.png> [--cols N] [--rows N] [--light]
              (the .ans file holds ANSI text, e.g. lines printed by the scene renderer)
As a module:  render(screen, out_path) for a pyte screen (test/tui.py uses this for `shot:` steps)

Half blocks (▀ ▄ █) are drawn as exact rectangles so pixel art comes out crisp; other characters
use DejaVu Sans Mono. Each cell is 9x18 px, roughly a real terminal's proportions.
"""
import sys
import pyte
from PIL import Image, ImageDraw, ImageFont

CELL_W, CELL_H = 9, 18
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
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


def render(screen, out_path, light=False):
    fg_default = (40, 40, 40) if light else (208, 208, 208)
    bg_default = (250, 250, 250) if light else (30, 30, 30)
    img = Image.new('RGB', (screen.columns * CELL_W, screen.lines * CELL_H), bg_default)
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, 15)
    bold = ImageFont.truetype(FONT_BOLD, 15)
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
                    glyphs.append((x0, y0 + 1, c, bold if ch.bold else font, fg))
    for x0, y0, c, f, fg in glyphs:
        draw.text((x0, y0), c, font=f, fill=fg)
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
