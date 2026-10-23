#!/usr/bin/env python3
"""Turn upscaled pixel-art images (e.g. AI-generated) back into exact pixel grids for the terminal.

    import-art.py --name cat --cell 22:36 --out src/ui/sprites/cat.ts  open=a.png blink=b.png ...
    import-art.py --name logo --cell 14:23 --out src/ui/sprites/logo.ts main=logo.png

Generated "pixel art" is drawn on a slightly irregular grid, so instead of assuming a fixed cell
size the script finds the cell boundaries from the image itself: it sums color edges along each
axis and picks the boundary positions (spaced within --cell min:max) that line up with the
strongest edges. All frames share one grid, so animation frames stay aligned. Each cell takes the
median color of its middle; similar colors are merged into one palette. The result is written as
a SpriteSheet module, plus a preview PNG next to it (--preview).
"""
import argparse
import string
import numpy as np
from PIL import Image


def premultiplied(a):
    return a[..., :3] * (a[..., 3:4] / 255.0)


def profile(frames, axis):
    """Edge strength at each boundary position along an axis (1 = columns, 0 = rows), summed over frames."""
    total = None
    for a in frames:
        d = np.abs(np.diff(premultiplied(a), axis=axis)).sum(axis=2)
        p = d.sum(axis=0 if axis == 1 else 1)
        p = np.concatenate([[0], p])  # boundary before index i
        total = p if total is None else total + p
    return total


def boundaries(p, gmin, gmax):
    """Boundary positions 0 = b0 < b1 < ... < bn = len(p) with gaps in [gmin, gmax], maximizing edge strength."""
    n = len(p)
    best = np.full(n + 1, -np.inf)
    prev = np.full(n + 1, -1)
    best[0] = 0
    # Let the first cell start anywhere in the first gap (margins are transparent anyway).
    for x in range(1, gmax):
        best[x] = p[x] if x < n else 0
        prev[x] = 0
    for x in range(gmax, n + 1):
        lo, hi = x - gmax, x - gmin
        if hi < 0:
            continue
        seg = best[max(lo, 0):hi + 1]
        k = int(np.argmax(seg))
        best[x] = seg[k] + (p[x] if x < n else 0)
        prev[x] = max(lo, 0) + k
    # End anywhere in the last gap.
    end = max(range(max(0, n - gmax), n + 1), key=lambda x: best[x])
    out = [end]
    while out[-1] > 0 and prev[out[-1]] >= 0:
        out.append(int(prev[out[-1]]))
    return sorted(set(out))


def sample(a, xs, ys):
    """One RGBA value per cell: the median of the cell's middle half."""
    h, w = len(ys) - 1, len(xs) - 1
    cells = np.zeros((h, w, 4), dtype=np.float32)
    for j in range(h):
        y0, y1 = ys[j], ys[j + 1]
        my = max(1, (y1 - y0) // 4)
        for i in range(w):
            x0, x1 = xs[i], xs[i + 1]
            mx = max(1, (x1 - x0) // 4)
            block = a[y0 + my:y1 - my, x0 + mx:x1 - mx].reshape(-1, 4)
            if len(block) == 0:
                block = a[y0:y1, x0:x1].reshape(-1, 4)
            cells[j, i] = np.median(block, axis=0)
    return cells


def build_palette(colors, merge):
    """Greedy clustering: most frequent colors first; anything within `merge` joins an existing color."""
    uniq, counts = np.unique(np.round(colors).astype(int), axis=0, return_counts=True)
    order = np.argsort(-counts)
    centers, weights = [], []
    for idx in order:
        c = uniq[idx].astype(np.float32)
        if centers:
            d = np.sqrt(((np.array(centers) - c) ** 2).sum(axis=1))
            k = int(np.argmin(d))
            if d[k] < merge:
                w = weights[k]
                centers[k] = (centers[k] * w + c * counts[idx]) / (w + counts[idx])
                weights[k] += counts[idx]
                continue
        centers.append(c)
        weights.append(counts[idx])
    return np.array(centers)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', required=True)
    ap.add_argument('--cell', default='14:40', help='min:max cell size in source pixels')
    ap.add_argument('--merge', type=float, default=22.0, help='merge colors closer than this (RGB distance)')
    ap.add_argument('--alpha', type=int, default=128)
    ap.add_argument('--out', required=True)
    ap.add_argument('--preview')
    ap.add_argument('frames', nargs='+', help='frameName=image.png')
    args = ap.parse_args()
    gmin, gmax = (int(v) for v in args.cell.split(':'))

    names, frames = [], []
    for spec in args.frames:
        name, path = spec.split('=', 1)
        names.append(name)
        frames.append(np.asarray(Image.open(path).convert('RGBA')).astype(np.float32))
    shape = frames[0].shape
    assert all(f.shape == shape for f in frames), 'all frames must be the same size'

    xs = boundaries(profile(frames, 1), gmin, gmax)
    ys = boundaries(profile(frames, 0), gmin, gmax)
    gx, gy = np.diff(xs), np.diff(ys)
    print(f'grid: {len(xs) - 1} x {len(ys) - 1} cells; cell width {gx.min()}-{gx.max()} (median {np.median(gx)}), '
          f'height {gy.min()}-{gy.max()} (median {np.median(gy)})')

    cells = [sample(a, xs, ys) for a in frames]
    opaque = [c[..., 3] >= args.alpha for c in cells]
    union = np.any(opaque, axis=0)
    rows = np.flatnonzero(union.any(axis=1))
    cols = np.flatnonzero(union.any(axis=0))
    r0, r1, c0, c1 = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    if (r1 - r0) % 2:  # half blocks: keep an even number of pixel rows, padding on top
        r0 -= 1
    print(f'sprite: {c1 - c0} x {r1 - r0} pixels -> {c1 - c0} columns x {(r1 - r0) // 2} text rows')

    all_colors = np.concatenate([c[o][:, :3] for c, o in zip(cells, opaque)])
    palette = build_palette(all_colors, args.merge)
    keys = [k for k in string.ascii_letters + string.digits if k != 'o'][:len(palette)]
    if len(palette) > len(keys):
        raise SystemExit(f'too many colors ({len(palette)}); raise --merge')
    hexes = ['#%02X%02X%02X' % tuple(int(round(v)) for v in c) for c in palette]
    print(f'palette: {len(palette)} colors')

    def key_for(rgb):
        return keys[int(np.argmin(((palette - rgb) ** 2).sum(axis=1)))]

    sheet = {}
    for name, c, o in zip(names, cells, opaque):
        rows_out = []
        for j in range(r0, r1):
            line = ''
            for i in range(c0, c1):
                inside = 0 <= j < c.shape[0]
                line += key_for(c[j, i, :3]) if inside and o[j, i] else '.'
            rows_out.append(line)
        sheet[name] = rows_out

    width, height = c1 - c0, r1 - r0
    ident = args.name
    with open(args.out, 'w') as f:
        f.write("import type { SpriteSheet } from './types.js';\n\n")
        f.write(f'// Generated by scripts/import-art.py from the original artwork; edit the art, not this file.\n')
        f.write(f'export const {ident}: SpriteSheet = {{\n')
        f.write(f"  name: '{ident}',\n  width: {width},\n  height: {height},\n")
        f.write('  palette: { ' + ', '.join(f"{k}: '{h}'" for k, h in zip(keys, hexes)) + ' },\n')
        f.write('  frames: {\n')
        for name, rows_out in sheet.items():
            f.write(f'    {name}: [\n')
            for r in rows_out:
                f.write(f"      '{r}',\n")
            f.write('    ],\n')
        f.write('  },\n};\n')
    print('wrote', args.out)

    if args.preview:
        scale = 12
        gap = scale * 2
        img = Image.new('RGB', (len(sheet) * (width * scale + gap) + gap, height * scale + gap * 2), (30, 30, 30))
        px = img.load()
        for n, rows_out in enumerate(sheet.values()):
            ox = gap + n * (width * scale + gap)
            for j, r in enumerate(rows_out):
                for i, ch in enumerate(r):
                    if ch == '.':
                        continue
                    col = tuple(int(hexes[keys.index(ch)][k:k + 2], 16) for k in (1, 3, 5))
                    for yy in range(scale):
                        for xx in range(scale):
                            px[ox + i * scale + xx, gap + j * scale + yy] = col
        img.save(args.preview)
        print('preview', args.preview)


if __name__ == '__main__':
    main()
