"""Repack the generated pigeon sheet into a regular, masked sprite grid.

The source sheet (brand-src/pigeon-states.png) is not a regular grid, so
sampling fixed windows from it bleeds neighbouring poses in and clips feet.
Each pose is isolated by its connected components and placed in a
CELL_W x CELL_H cell, keeping its measured body center and foot baseline.

Usage: python3 scripts/pack-pigeon.py
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'brand-src/pigeon-states.png'
OUT = ROOT / 'public/brand/pigeon-sprites.png'
CELL_W, CELL_H, FOOT_PAD = 320, 256, 4

# Row order matches PigeonState in src/ui/Pigeon.tsx: (band top, band bottom, body centers).
ROWS = [
    (0, 310, [195, 490, 790, 1080]),     # idle
    (310, 540, [220, 515, 810, 1100]),   # indexing
    (540, 775, [185, 480, 780, 1075]),   # drafting
    (775, 1005, [185, 480, 780, 1075]),  # opened
    (1005, 1254, [190, 485, 785, 1080]), # error
]

src = np.array(Image.open(SRC).convert('RGBA'))
labels, count = ndimage.label(ndimage.binary_dilation(src[..., 3] > 20, iterations=6))
owner = {}
for index, box in enumerate(ndimage.find_objects(labels), start=1):
    cy, cx = (box[0].start + box[0].stop) / 2, (box[1].start + box[1].stop) / 2
    row = next(r for r, (top, bottom, _) in enumerate(ROWS) if top <= cy < bottom)
    col = int(np.argmin([abs(cx - c) for c in ROWS[row][2]]))
    owner.setdefault((row, col), []).append(index)

atlas = np.zeros((CELL_H * len(ROWS), CELL_W * 4, 4), np.uint8)
for row, (_, _, centers) in enumerate(ROWS):
    parts = [i for col in range(4) for i in owner[(row, col)]]
    baseline = max(ndimage.find_objects(labels)[i - 1][0].stop for i in parts) + FOOT_PAD
    for col, center in enumerate(centers):
        mask = np.isin(labels, owner[(row, col)]) & (src[..., 3] > 0)
        ys, xs = np.nonzero(mask)
        y0, x0 = baseline - CELL_H, center - CELL_W // 2
        assert ys.min() >= y0 and xs.min() >= x0 and xs.max() < x0 + CELL_W, (row, col)
        cell = atlas[row * CELL_H:(row + 1) * CELL_H, col * CELL_W:(col + 1) * CELL_W]
        cell[ys - y0, xs - x0] = src[ys, xs]

Image.fromarray(atlas).save(OUT, optimize=True)
Image.fromarray(atlas).save(OUT.with_suffix(".webp"), lossless=True, exact=True, method=6)
print(f'wrote {OUT.relative_to(ROOT)} ({atlas.shape[1]}x{atlas.shape[0]})')
