# Sprites

Pixel art drawn in the terminal with half blocks (`▀`): each character cell shows two square
pixels, top and bottom, in 24-bit color.

| sheet | size (px) | frames | used for |
|-------|-----------|--------|----------|
| `cat.ts` | 32 × 42 | `open`, `twitch`, `half`, `closed` | the cat on the desk and above the prompt |
| `logo.ts` | 112 × 24 | `main` | the Zoi Code wordmark on the opening screen |
| `computer.ts` | 34 × 24 | `main` | the computer on the desk; its `S` pixels are the screen |

## Format

A `SpriteSheet` (`types.ts`) has named frames that all share one size. A frame is a list of rows
with one character per pixel. `.` is transparent, and any other character is a key in the sheet's
`palette`. `validateSheet` checks the sizes and palette keys. `SHEET_SPECS` in `index.ts` lists each
sheet's required frames and limits how far animation frames may differ from their base frame, so
the cat's body never jumps between frames.

## Where the cat and logo come from

They are converted from the original artwork in `art/` by `scripts/import-art.py`. The script
finds the art-pixel grid in an upscaled image (generated pixel art has a slightly irregular grid),
samples one color per pixel and merges near-identical colors into a palette:

```sh
pip install numpy pillow
python3 scripts/import-art.py --name logo --cell 14:23 --merge 26 --out src/ui/sprites/logo.ts main=art/logo.png
python3 scripts/import-art.py --name cat --cell 22:36 --out /tmp/cat.ts \
  open=art/cat-open.png twitch=art/cat-flick.png half=art/cat-half.png closed=art/cat-closed.png
```

The cat was then touched up by hand. The source draws its eyes and mouth at half-pixel detail,
so they were redrawn at sprite resolution, and every frame was rebuilt from one shared body, so
only the eyes (blinks) or the tail (twitch) change. Re-running the import overwrites that work, so
redo the touch-up afterwards.

## Previewing

```sh
npx tsx scripts/sprite-preview.ts all --out /tmp/sprites.png   # validate and render every sheet
npx tsx scripts/scene-preview.ts --out /tmp/scene              # opening, hop and banner frames
```
