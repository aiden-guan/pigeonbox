"""Pigeon sprites for the launch film.

1. Re-quantizes the shipped sprite sheet (apps/extension/public/brand/pigeon-sprites.png)
   onto its true ~6.4px pixel grid so it composes crisply with the pixel-art world.
2. Draws a side-view flight cycle of the same character (gray body, ivory belly,
   peach beak, brown messenger satchel) that the product sheet does not include.
"""
from __future__ import annotations

import os

import numpy as np
from PIL import Image

from pixelkit import Canvas, Mask, dilate, hexc, outline, rot, shade, shift

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'art')
os.makedirs(OUT, exist_ok=True)

# Colours sampled from the product sprite sheet.
INK = '#18181e'
LINE = '#2c2c38'
BODY = '#9899a3'
BODY_L = '#b4b5bd'
BODY_D = '#6b6c80'
BODY_DD = '#4a4b5e'
BELLY = '#e7dfd6'
BELLY_D = '#c9c0b6'
BEAK = '#e89868'
BEAK_L = '#f4bc8c'
BROWN = '#906642'
BROWN_L = '#a47a52'
BROWN_D = '#5e4230'


def requantize_sheet():
    src = Image.open(os.path.join(ROOT, 'public', 'brand', 'pigeon-sprites.png')).convert('RGBA')
    cw, ch = 50, 40
    sheet = Image.new('RGBA', (cw * 4, ch * 5))
    for r in range(5):
        for c in range(4):
            cell = src.crop((c * 320, r * 256, c * 320 + 320, r * 256 + 256))
            small = cell.resize((cw, ch), Image.Resampling.BOX)
            a = np.array(small)
            a[..., 3] = np.where(a[..., 3] > 110, 255, 0)
            sheet.alpha_composite(Image.fromarray(a), (c * cw, r * ch))
    sheet.save(os.path.join(OUT, 'pigeon-sheet-1x.png'))


# ---------------------------------------------------------------- flight cycle
W, H = 56, 50
BODY_CX, BODY_CY = 27, 25


def wing_poly(angle: float, spread: float, fold: float = 0.0):
    """Near wing as a polygon rooted at the shoulder.

    angle: degrees, 0 = horizontal backwards, negative = raised, positive = lowered.
    spread: length multiplier.
    """
    sx, sy = 30, 21  # shoulder
    L = 22 * spread
    # Leading edge bends at the wrist; feathers fan behind.
    base = [
        (sx, sy),
        (sx - 7, sy - 2),              # elbow
        (sx - 14, sy - 3 + fold),     # wrist
        (sx - L, sy - 1 + fold),       # primary tip
        (sx - L + 3, sy + 2 + fold),
        (sx - L + 6, sy + 1 + fold),   # feather scallops
        (sx - L + 8, sy + 4 + fold),
        (sx - L + 11, sy + 3 + fold),
        (sx - 10, sy + 6),
        (sx - 6, sy + 6),
        (sx - 1, sy + 4),
    ]
    return rot(base, sx, sy, -angle)


def draw_flight_frame(angle: float, spread: float, bob: int, fold: float = 0.0) -> Canvas:
    cv = Canvas(W, H)
    oy = bob

    # far wing (behind the body), darker and offset up
    far = Mask(W, H).poly([(x + 2, y - 2 + oy) for x, y in wing_poly(angle - 8, spread * 0.92, fold)]).arr()

    body = Mask(W, H).ellipse(BODY_CX, BODY_CY + oy, 11, 8).arr()
    head = Mask(W, H).ellipse(38, 16 + oy, 7, 7).arr()
    neck = Mask(W, H).poly([(31, 17 + oy), (37, 13 + oy), (40, 22 + oy), (33, 27 + oy)]).arr()
    tail = Mask(W, H).poly([(19, 21 + oy), (10, 21 + oy), (8, 23 + oy), (10, 26 + oy), (19, 28 + oy)]).arr()
    beak = Mask(W, H).poly([(44, 16 + oy), (48, 18 + oy), (44, 19 + oy)]).arr()
    bag = Mask(W, H).poly([(22, 29 + oy), (30, 29 + oy), (30, 35 + oy), (28, 37 + oy), (23, 37 + oy), (22, 35 + oy)]).arr()
    near = Mask(W, H).poly([(x, y + oy) for x, y in wing_poly(angle, spread, fold)]).arr()
    feet = Mask(W, H).rect(21, 31 + oy, 22, 32 + oy).arr()

    silhouette = far | body | head | neck | tail | beak | bag | near | feet

    # far wing
    cv.fill(far, BODY_DD)
    cv.fill(far & ~shift(far, 0, 1), BODY_D)
    # tail
    shade(cv, tail, BODY_D, BODY, BODY_DD, band_dark=0.7)
    tail_bars = tail & (np.arange(W)[None, :] < 12)
    cv.fill(tail_bars, BODY_DD)
    # body + head
    torso = body | neck | head
    shade(cv, torso, BODY, BODY_L, BODY_D, band_light=0.18, band_dark=0.72)
    # belly: lower-front of torso
    yy, xx = np.mgrid[0:H, 0:W]
    belly = torso & (yy > 24 + oy + (34 - xx) * 0.25) & (xx > 22)
    cv.fill(belly, BELLY)
    cv.fill(belly & ~shift(belly, 0, -1), BELLY_D)
    # darker head cap for readability
    cap = head & (yy < 15 + oy)
    cv.fill(cap, BODY_L)
    # feet tucked
    cv.fill(feet, BEAK)
    # satchel strap across the chest, from the back to the bag
    strap = Mask(W, H).line([(33, 12 + oy), (37, 24 + oy), (30, 30 + oy)], width=1).arr() & (torso | bag)
    cv.fill(strap, BROWN_D)
    strap_hi = shift(strap, -1, 0) & torso & ~strap
    cv.fill(strap_hi, BROWN)
    # bag
    shade(cv, bag, BROWN, BROWN_L, BROWN_D, band_dark=0.8)
    flap = bag & (yy < 32 + oy)
    cv.fill(flap, BROWN_L)
    cv.fill(flap & ~shift(flap, 0, -1), BROWN_D)
    cv.px(26, 32 + oy, '#d9b27c')  # buckle
    # near wing on top with its own inner contour
    dist = np.hypot(xx - 30, yy - (21 + oy)) / (22 * spread)
    cv.fill(near, BODY)
    cv.fill(near & (dist < 0.42), BODY_L)
    cv.fill(near & (dist > 0.68), BODY_D)
    # feather notches along the primaries
    notch = near & (dist > 0.7) & (((xx + yy) % 3) == 0) & ~shift(near, 0, -1)
    cv.fill(notch, BODY_DD)
    cv.fill(near & (dist > 0.5) & (dist < 0.56), BODY_DD)
    lead = near & ~shift(near, 0, 1)
    cv.fill(lead & (dist < 0.68), '#c9cad0')
    near_edge = near & ~(shift(near, 1, 0) & shift(near, -1, 0) & shift(near, 0, 1) & shift(near, 0, -1))
    cv.fill(near_edge & (torso | far | tail), LINE)
    # beak
    shade(cv, beak, BEAK, BEAK_L, '#c9784e', rim_dark=False)
    # eye with a catchlight
    cv.px(41, 15 + oy, INK)
    cv.px(41, 14 + oy, INK)
    cv.px(42, 15 + oy, INK)
    cv.px(42, 14 + oy, '#ffffff')
    outline(cv, silhouette, INK)
    return cv


def flight_cycle():
    frames = [
        # angle, spread, bob, fold
        (-66, 1.12, 1, 0),   # wings high
        (-24, 1.12, 0, 0),   # sweeping down
        (30, 0.98, -1, 1),   # wings low
        (-6, 0.82, 0, 2),    # recovery, wings tucked a little
    ]
    glide = (-10, 1.14, 0, 0)
    strip = Image.new('RGBA', (W * 5, H))
    for i, f in enumerate(frames + [glide]):
        strip.alpha_composite(draw_flight_frame(f[0], f[1], f[2] + 5, f[3]).image(), (i * W, 0))
    strip.save(os.path.join(OUT, 'pigeon-fly-1x.png'))


if __name__ == '__main__':
    requantize_sheet()
    flight_cycle()
    print('ok')
