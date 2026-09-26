"""Procedural pixel-art city for the PigeonBox launch film.

Writes parallax plates and small animated sprites to public/art and a manifest to
src/art-manifest.json that the Remotion scenes read for sizes and anchor points.
Run: python3 scripts/gen_world.py
"""
from __future__ import annotations

import json
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw

from pixelkit import Canvas, Mask, dilate, hexc, mix, shift

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'art')
os.makedirs(OUT, exist_ok=True)
MANIFEST: dict = {}

BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) / 16.0

# --------------------------------------------------------------------- palette
SKY_TOP = '#a9c3c8'
SKY_MID = '#e9dcc6'
SKY_LOW = '#f4c99e'
SUN = '#fff1d6'
HAZE = '#edd2b2'

BRICK = ['#a65a3f', '#b86a4a', '#8f4d39', '#c07c5b']
STONE = ['#d7b48c', '#e3cba7', '#c9a57f', '#e8d9bf']
SOOT = ['#4a4640', '#5c5750', '#3e3b37']
SLATE = ['#687080', '#7a8190', '#5a6070']
TEAL = ['#4f7b78', '#5f8f86', '#3f6664']
CREAM = ['#eee3cc', '#f2e8d5', '#e2d4b8']
FACADES = BRICK + STONE + SOOT[:2] + SLATE[:2] + TEAL[:2] + CREAM
ROOF_VERDIGRIS = '#6fa08f'
GLASS_D = '#2f2d33'
GLASS_SKY = '#b7c9cc'
LIT = ['#f7c873', '#f4b664', '#fbd98f']
LEAF = ['#5f7d4a', '#7b9656', '#4a653c', '#8faa62']
LEAF_D = '#3a5132'
TRUNK = '#5a4332'
ASPHALT = '#4b4845'
SIDEWALK = '#b9ab96'
INK = '#1d1b1a'


def dither_gradient(w: int, h: int, stops: list[tuple[float, str]]) -> Canvas:
    """Vertical gradient quantized to the stop colours with a 4x4 Bayer dither."""
    cv = Canvas(w, h)
    ys = np.arange(h) / max(1, h - 1)
    colors = [np.array(hexc(c), dtype=np.float32) for _, c in stops]
    pos = [p for p, _ in stops]
    for y in range(h):
        t = ys[y]
        i = 0
        while i < len(pos) - 2 and t > pos[i + 1]:
            i += 1
        lt = (t - pos[i]) / max(1e-6, pos[i + 1] - pos[i])
        lt = min(1, max(0, lt))
        # 4 intermediate steps between stops, dithered
        steps = 4
        q = lt * steps
        base = math.floor(q)
        frac = q - base
        row_thr = BAYER[y % 4][np.arange(w) % 4]
        k = base + (frac > row_thr)
        k = np.clip(k, 0, steps)
        tt = (k / steps)[:, None]
        cv.a[y] = (colors[i] * (1 - tt) + colors[i + 1] * tt).astype(np.uint8)
    return cv


def hazed(c: str, amt: float, haze: str = HAZE):
    return mix(c, haze, amt)


# ------------------------------------------------------------------ primitives
def draw_window(cv: Canvas, x, y, w, h, rng: random.Random, haze: float, lit_p: float, frame=True):
    lit = rng.random() < lit_p
    if lit:
        c = hazed(rng.choice(LIT), haze * 0.6)
        cv.rect(x, y, x + w - 1, y + h - 1, c)
        if h >= 3 and rng.random() < 0.5:
            cv.rect(x, y, x + w - 1, y, hazed('#fde8b0', haze * 0.6))
        if w >= 3 and rng.random() < 0.35:  # curtain
            cv.rect(x, y, x, y + h - 1, hazed('#c56f4f', haze))
    else:
        cv.rect(x, y, x + w - 1, y + h - 1, hazed(GLASS_D, haze))
        cv.rect(x, y, x + w - 1, y + max(0, h // 3 - 1), hazed(GLASS_SKY, haze))
        if w >= 3 and h >= 3:
            cv.px(x + w - 1, y + h - 1, hazed('#45424a', haze))
    if frame and w >= 3 and h >= 4:
        cv.rect(x - 0, y + h, x + w - 1, y + h, hazed('#efe3cf', haze * 0.8))  # sill


def building(cv: Canvas, x: int, base: int, w: int, h: int, rng: random.Random, haze: float = 0.0,
             lit_p: float = 0.12, detail: int = 2, palette=None, anchors=None):
    """A facade with windows, cornice and roof clutter. detail: 0 silhouette .. 3 full."""
    top = base - h
    face = rng.choice(palette or FACADES)
    light = mix(face, '#ffffff', 0.16)
    dark = mix(face, '#1b1a1f', 0.28)
    cv.rect(x, top, x + w - 1, base, hazed(face, haze))
    if detail == 0:
        # silhouettes only get a few lit specks
        for _ in range(int(w * h / 90)):
            wx, wy = rng.randrange(x + 1, x + w - 1), rng.randrange(top + 2, base)
            if rng.random() < 0.25:
                cv.px(wx, wy, hazed(rng.choice(LIT), haze * 0.7))
        return top
    # light left edge, shadow right edge (sun is low on the left)
    cv.rect(x, top, x, base, hazed(light, haze))
    shade_w = max(1, w // 7)
    cv.rect(x + w - shade_w, top, x + w - 1, base, hazed(dark, haze))
    # cornice
    cv.rect(x - 1, top, x + w, top + 1, hazed(mix(face, '#fff4e0', 0.3), haze))
    cv.rect(x - 1, top + 2, x + w, top + 2, hazed(dark, haze))
    # windows grid
    win_w = rng.choice([2, 2, 3, 3, 4]) if detail >= 2 else 1
    win_h = win_w + rng.choice([1, 2, 3])
    gap_x = rng.choice([2, 3, 4])
    gap_y = rng.choice([3, 4, 5])
    cols = max(1, (w - 4 + gap_x) // (win_w + gap_x))
    margin = (w - (cols * (win_w + gap_x) - gap_x)) // 2
    y = top + 5
    floor_band = rng.random() < 0.4
    while y + win_h < base - (8 if detail >= 2 else 2):
        if floor_band and detail >= 2:
            cv.rect(x + 1, y + win_h + 1, x + w - shade_w - 1, y + win_h + 1, hazed(mix(face, '#000000', 0.12), haze))
        for c in range(cols):
            wx = x + margin + c * (win_w + gap_x)
            draw_window(cv, wx, y, win_w, win_h, rng, haze, lit_p, frame=detail >= 2)
        y += win_h + gap_y
    # roof clutter
    if detail >= 1:
        roof_things(cv, x, top, w, rng, haze, detail, anchors)
    return top


def water_tower(cv: Canvas, x, top, haze, s=1.0):
    wood = hazed('#7a5236', haze)
    wood_l = hazed('#95684a', haze)
    band = hazed('#3e342d', haze)
    tw, th = int(9 * s), int(9 * s)
    leg_h = int(5 * s)
    by = top - leg_h
    for lx in (x + 1, x + tw - 2):
        cv.rect(lx, by, lx, top - 1, band)
    cv.rect(x + 1, by - 1, x + tw - 2, by - 1, band)
    cv.rect(x, by - th, x + tw - 1, by - 2, wood)
    cv.rect(x, by - th, x + 1, by - 2, wood_l)
    for yy in range(by - th + 2, by - 2, 3):
        cv.rect(x, yy, x + tw - 1, yy, band)
    # conical roof
    for i in range(3):
        cv.rect(x - 1 + i, by - th - 1 - i, x + tw - i, by - th - 1 - i, band)


def roof_things(cv: Canvas, x, top, w, rng: random.Random, haze, detail, anchors=None):
    n = rng.randint(1, 3 if detail >= 3 else 2)
    used = []
    for _ in range(n):
        kind = rng.choice(['tower', 'vent', 'vent', 'antenna', 'ac', 'garden', 'chimney', 'dish', 'line'])
        if detail < 3 and kind in ('garden', 'line', 'dish'):
            kind = 'vent'
        px = rng.randrange(x + 2, max(x + 3, x + w - 10))
        if any(abs(px - u) < 10 for u in used):
            continue
        used.append(px)
        if kind == 'tower' and w > 14:
            water_tower(cv, px, top, haze)
        elif kind == 'vent':
            cv.rect(px, top - 3, px + 2, top - 1, hazed('#8d8a86', haze))
            cv.rect(px - 1, top - 4, px + 3, top - 4, hazed('#6c6965', haze))
        elif kind == 'antenna':
            h = rng.randint(8, 16)
            cv.rect(px, top - h, px, top - 1, hazed('#4a4745', haze))
            cv.rect(px - 2, top - h + 3, px + 2, top - h + 3, hazed('#4a4745', haze))
            cv.px(px, top - h - 1, hazed('#e86a4a', haze * 0.5))
        elif kind == 'ac':
            cv.rect(px, top - 4, px + 5, top - 1, hazed('#b9b4ab', haze))
            cv.rect(px + 1, top - 3, px + 2, top - 2, hazed('#6e6a64', haze))
        elif kind == 'chimney':
            cv.rect(px, top - 6, px + 2, top - 1, hazed('#8e4c38', haze))
            cv.rect(px - 1, top - 7, px + 3, top - 7, hazed('#5a3326', haze))
            if anchors is not None:
                anchors.setdefault('smoke', []).append([px + 1, top - 8])
        elif kind == 'dish':
            cv.rect(px + 1, top - 3, px + 1, top - 1, hazed('#77736e', haze))
            cv.rect(px - 1, top - 6, px + 3, top - 4, hazed('#e5e0d6', haze))
        elif kind == 'garden':
            for i in range(0, min(12, w - 4), 3):
                c = rng.choice(LEAF)
                cv.rect(px + i, top - 3, px + i + 2, top - 1, hazed(c, haze))
                if rng.random() < 0.4:
                    cv.px(px + i + 1, top - 4, hazed('#e98a6a', haze))
        elif kind == 'line':
            ln = min(18, w - 4)
            cv.rect(px, top - 8, px, top - 1, hazed('#4a4745', haze))
            cv.rect(px + ln, top - 8, px + ln, top - 1, hazed('#4a4745', haze))
            for i in range(ln):
                sag = int(round(2 * math.sin(math.pi * i / ln)))
                cv.px(px + i, top - 8 + sag, hazed('#3a3836', haze))
                if i % 4 == 1 and 2 < i < ln - 2:
                    c = rng.choice(['#e9e1d2', '#d97b5b', '#7ea5b8', '#f0c96b'])
                    cv.rect(px + i, top - 7 + sag, px + i + 2, top - 4 + sag, hazed(c, haze))


def tree(cv: Canvas, x, base, size, rng: random.Random, haze=0.0, kind='round'):
    trunk_h = int(size * 0.55)
    cv.rect(x, base - trunk_h, x + max(1, size // 8), base, hazed(TRUNK, haze))
    cy = base - trunk_h - size // 3
    blobs = []
    for _ in range(6 + size // 3):
        bx = x + rng.randint(-size // 2, size // 2)
        by = cy + rng.randint(-size // 3, size // 4)
        r = rng.randint(max(2, size // 5), max(3, size // 3))
        blobs.append((bx, by, r))
    m = Mask(cv.w, cv.h)
    for bx, by, r in blobs:
        m.ellipse(bx, by, r, int(r * 0.85))
    ma = m.arr()
    cv.fill(ma, hazed(LEAF[0], haze))
    # light from upper left
    lit = ma & ~shift(ma, 2, 2)
    cv.fill(lit, hazed(LEAF[3], haze))
    dark = ma & ~shift(ma, -2, -2)
    cv.fill(dark, hazed(LEAF_D, haze))
    # speckle
    ys, xs = np.nonzero(ma)
    for i in range(0, len(xs), 7):
        if rng.random() < 0.5:
            cv.px(xs[i], ys[i], hazed(LEAF[1], haze))


def cloud(w, h, rng: random.Random, color='#fbf1e2', shade='#ead3bb') -> Canvas:
    cv = Canvas(w, h)
    m = Mask(w, h)
    for _ in range(10):
        r = rng.randint(h // 4, h // 2)
        cx = rng.randint(r, w - r)
        cy = rng.randint(h // 2, h - r // 2 - 1)
        m.ellipse(cx, cy, r + rng.randint(0, r), r)
    m.rect(4, h - h // 4, w - 5, h - 2)
    a = m.arr()
    cv.fill(a, color)
    cv.fill(a & ~shift(a, 0, -2), shade)
    return cv


def save(cv: Canvas, name: str, **meta):
    cv.save(os.path.join(OUT, name))
    MANIFEST[name.replace('.png', '')] = {'w': cv.w, 'h': cv.h, **meta}


# ------------------------------------------------------------------- shared sky
def sky_plate(w, h, sun_xy=None, seed=1, top=SKY_TOP, mid=SKY_MID, low=SKY_LOW):
    cv = dither_gradient(w, h, [(0, top), (0.55, mid), (1.0, low)])
    if sun_xy:
        sx, sy = sun_xy
        yy, xx = np.mgrid[0:h, 0:w]
        d = np.hypot(xx - sx, (yy - sy) * 1.15)
        thr = BAYER[yy % 4, xx % 4]
        for r, c, strength in [(70, '#f8dcb4', 0.5), (40, '#fbe6c4', 0.7), (22, '#fdf0d8', 0.9)]:
            t = np.clip(1 - d / r, 0, 1) * strength
            cv.fill((t > thr) & (d < r), c)
        cv.fill(d < 9, SUN)
    return cv


def skyline(w, h, base, rng, haze, hmin, hmax, wmin, wmax, detail, lit_p=0.1, gap=(0, 3), palette=None,
            landmarks=False, anchors=None):
    cv = Canvas(w, h)
    x = -rng.randint(0, 10)
    while x < w:
        bw = rng.randint(wmin, wmax)
        bh = rng.randint(hmin, hmax)
        if landmarks and rng.random() < 0.08:
            # spire / dome landmark
            if rng.random() < 0.5:
                top = building(cv, x, base, bw, bh + 20, rng, haze, lit_p, detail, palette)
                for i in range(12):
                    cv.rect(x + bw // 2 - max(0, 3 - i // 3), top - i, x + bw // 2 + max(0, 3 - i // 3), top - i,
                            hazed('#6c7d82', haze))
            else:
                top = building(cv, x, base, bw, bh, rng, haze, lit_p, detail, palette)
                m = Mask(w, h).ellipse(x + bw // 2, top, bw // 2 - 1, bw // 3).arr()
                m &= (np.arange(h)[:, None] <= top)
                cv.fill(m, hazed(ROOF_VERDIGRIS, haze))
        else:
            building(cv, x, base, bw, bh, rng, haze, lit_p, detail, palette, anchors)
        x += bw + rng.randint(*gap)
    return cv


# ================================================================== SHOTS
def shot_rooftops():
    """J1: sunrise over the rooftops. Camera travels right."""
    travel = 520  # near-plane art px
    W0, H0 = 480, 270
    rng = random.Random(11)
    save(sky_plate(W0 + 40, H0, sun_xy=(150, 150)), 'j1_sky.png', parallax=0.02)
    far = skyline(W0 + int(travel * 0.12) + 40, H0, 205, rng, 0.72, 40, 110, 10, 26, 0, gap=(0, 2), landmarks=True)
    save(far, 'j1_far.png', parallax=0.12)
    mid = skyline(W0 + int(travel * 0.4) + 60, H0, 235, rng, 0.38, 30, 90, 16, 36, 1, lit_p=0.15)
    save(mid, 'j1_mid.png', parallax=0.4)
    anchors: dict = {}
    near = Canvas(W0 + travel + 80, H0)
    x = -4
    while x < near.w:
        bw = rng.randint(34, 70)
        bh = rng.randint(40, 95)
        building(near, x, H0 + 10, bw, bh, rng, 0.0, 0.18, 3, anchors=anchors)
        x += bw + rng.randint(0, 6)
    save(near, 'j1_near.png', parallax=1.0, anchors=anchors)
    # foreground: wires with pigeons and a couple of chimney stacks
    fg = Canvas(W0 + int(travel * 1.6) + 80, H0)
    for px in range(120, fg.w, 330):
        fg.rect(px, 150, px + 3, H0, '#2b2724')
        fg.rect(px - 10, 160, px + 13, 161, '#2b2724')
    for i in range(fg.w):
        for base_y, amp in [(162, 14), (170, 18)]:
            seg = (i - 120) % 330
            sag = int(amp * math.sin(math.pi * seg / 330))
            fg.px(i, base_y + sag, '#2b2724')
    save(fg, 'j1_fg.png', parallax=1.6)
    MANIFEST['j1'] = {'travel': travel}


def shopfront(cv: Canvas, x, ground, w, rng: random.Random, anchors):
    """Ground floor shop with awning, sign and display window."""
    face = rng.choice(['#3e3b37', '#5d3a2f', '#2f4a48', '#4b4f5c', '#6b3f33'])
    cv.rect(x, ground - 30, x + w - 1, ground, face)
    # display glass with warm interior
    cv.rect(x + 3, ground - 20, x + w - 12, ground - 3, '#f2c27f')
    cv.rect(x + 3, ground - 20, x + w - 12, ground - 16, '#f7d9a4')
    for sx in range(x + 6, x + w - 12, 7):
        cv.rect(sx, ground - 12, sx + 3, ground - 4, rng.choice(['#b35d42', '#6e8a5a', '#e7d3b0', '#56697a']))
    # door
    cv.rect(x + w - 10, ground - 20, x + w - 4, ground, '#2a2522')
    cv.rect(x + w - 9, ground - 19, x + w - 5, ground - 12, '#e8b977')
    # awning, striped
    colors = rng.choice([('#c65a43', '#f1e4cf'), ('#2f6a63', '#f1e4cf'), ('#d49a3a', '#f6ecd8'), ('#3b4a6b', '#e8dcc6')])
    for i in range(w + 4):
        c = colors[(i // 3) % 2]
        cv.rect(x - 2 + i, ground - 27, x - 2 + i, ground - 23, c)
        if i % 3 == 1:
            cv.px(x - 2 + i, ground - 22, c)
    cv.rect(x - 2, ground - 28, x + w + 1, ground - 28, mix(colors[0], '#000000', 0.3))
    # sign board
    sign_w = min(w - 8, 26)
    cv.rect(x + 4, ground - 36, x + 4 + sign_w, ground - 30, '#221f1d')
    anchors.setdefault('signs', []).append([x + 4, ground - 36, sign_w, 7])


def shot_street():
    """J2: busy street canyon."""
    travel = 760
    W0, H0 = 480, 270
    rng = random.Random(23)
    anchors: dict = {}
    save(sky_plate(W0 + 60, H0, sun_xy=(90, 40), top='#b5cbcd', mid='#efdcc2', low='#f2cfa6'), 'j2_sky.png',
         parallax=0.03)
    far = skyline(W0 + int(travel * 0.25) + 60, H0, 200, rng, 0.55, 90, 170, 20, 40, 1, lit_p=0.1)
    save(far, 'j2_far.png', parallax=0.25)
    # main facade row with shops at street level
    near = Canvas(W0 + travel + 120, H0)
    ground = 214
    x = -6
    while x < near.w:
        bw = rng.randint(48, 84)
        bh = rng.randint(150, 215)
        building(near, x, ground - 30, bw, bh - 30, rng, 0.0, 0.2, 3, anchors=anchors)
        shopfront(near, x, ground, bw, rng, anchors)
        x += bw
    # sidewalk + curb + street
    near.rect(0, ground + 1, near.w, ground + 8, SIDEWALK)
    for sx in range(0, near.w, 12):
        near.rect(sx, ground + 1, sx, ground + 8, mix(SIDEWALK, '#000000', 0.08))
    near.rect(0, ground + 9, near.w, ground + 10, '#8a8073')
    near.rect(0, ground + 11, near.w, H0, ASPHALT)
    for sx in range(0, near.w, 30):
        near.rect(sx, 250, sx + 14, 251, '#e2d6bd')
    save(near, 'j2_near.png', parallax=1.0, anchors=anchors, ground=ground)
    # foreground lamp posts and street trees (fast parallax, darker)
    fg = Canvas(W0 + int(travel * 1.5) + 120, H0)
    for px in range(60, fg.w, 170):
        c = '#23201e'
        fg.rect(px, 120, px + 2, H0, c)
        fg.rect(px - 7, 118, px + 3, 119, c)
        fg.rect(px - 9, 116, px - 5, 121, '#f6d48d')
        fg.rect(px - 10, 115, px - 4, 115, c)
    save(fg, 'j2_fg.png', parallax=1.5)
    MANIFEST['j2'] = {'travel': travel}


def shot_park():
    """J3: park, river, bridge and clock tower."""
    travel = 820
    W0, H0 = 480, 270
    rng = random.Random(37)
    anchors: dict = {}
    save(sky_plate(W0 + 60, H0, sun_xy=(380, 60), top='#a7c5cd', mid='#eadfcb', low='#f1d3ad'), 'j3_sky.png',
         parallax=0.03)
    far = skyline(W0 + int(travel * 0.15) + 60, H0, 176, rng, 0.62, 30, 90, 12, 30, 0, landmarks=True)
    # clock tower landmark on the far plane
    tx = 300
    far.rect(tx, 60, tx + 22, 176, hazed('#c9a57f', 0.45))
    far.rect(tx, 60, tx + 1, 176, hazed('#e3cba7', 0.45))
    far.rect(tx + 19, 60, tx + 22, 176, hazed('#a8845f', 0.45))
    for i in range(16):
        far.rect(tx + 11 - min(12, i // 1 * 12 // 15), 44 + i, tx + 11 + min(12, i * 12 // 15), 44 + i, hazed(ROOF_VERDIGRIS, 0.35))
    far.rect(tx + 10, 36, tx + 12, 44, hazed('#4f7b78', 0.35))
    m = Mask(far.w, far.h).ellipse(tx + 11, 78, 8, 8).arr()
    far.fill(m, '#f4ecdc')
    far.fill(dilate(m) & ~m, hazed('#5a4a3a', 0.2))
    anchors['clock'] = [tx + 11, 78, 8]
    save(far, 'j3_far.png', parallax=0.15, anchors=anchors)
    # mid: river bank trees + bridge
    mid = Canvas(W0 + int(travel * 0.45) + 60, H0)
    water_y = 196
    mid.rect(0, water_y, mid.w, H0, '#7fa3a6')
    for i in range(0, mid.w, 1):
        mid.px(i, water_y, '#b9d0cd')
    bx = 380
    # arched stone bridge
    mid.rect(bx, 170, bx + 260, 178, '#c9ad89')
    mid.rect(bx, 168, bx + 260, 169, '#e1cba9')
    for ax in range(bx, bx + 260, 52):
        mid.rect(ax, 178, ax + 6, water_y, '#b4966f')
        arch = Mask(mid.w, mid.h).ellipse(ax + 29, water_y + 2, 21, 17).arr() & (np.arange(mid.h)[:, None] > 178)
        mid.fill(Mask(mid.w, mid.h).rect(ax + 7, 179, ax + 51, water_y).arr() & ~arch, '#b4966f')
    for lx in range(bx + 10, bx + 260, 26):
        mid.rect(lx, 160, lx, 167, '#3a3633')
        mid.rect(lx - 1, 158, lx + 1, 159, '#f6d48d')
    anchors_mid = {'water_y': water_y, 'bridge': [bx, 168, 260]}
    for tx2 in range(10, bx - 10, 22):
        tree(mid, tx2, water_y - 1, rng.randint(22, 34), rng, 0.2)
    for tx2 in range(bx + 280, mid.w, 24):
        tree(mid, tx2, water_y - 1, rng.randint(20, 30), rng, 0.2)
    save(mid, 'j3_mid.png', parallax=0.45, anchors=anchors_mid)
    # near: park lawn with trees, paths, fountain; river begins at the right
    near = Canvas(W0 + travel + 120, H0)
    lawn_y = 222
    near.rect(0, lawn_y, near.w, H0, '#8faa62')
    for i in range(0, near.w, 2):
        if rng.random() < 0.35:
            near.px(i, lawn_y + rng.randint(0, 40), '#7b9656')
        if rng.random() < 0.08:
            near.px(i, lawn_y + rng.randint(4, 40), rng.choice(['#f2e3a1', '#e98a6a', '#fbf4e6']))
    near.rect(0, lawn_y + 18, near.w, lawn_y + 23, '#dccaa6')  # path
    near.rect(0, lawn_y, near.w, lawn_y, '#a8c07a')
    fx = 360
    near.rect(fx - 18, lawn_y + 4, fx + 18, lawn_y + 12, '#d9cbb3')
    near.rect(fx - 16, lawn_y + 5, fx + 16, lawn_y + 9, '#8fbfc4')
    near.rect(fx - 2, lawn_y - 10, fx + 2, lawn_y + 5, '#cdbfa6')
    near.rect(fx - 6, lawn_y - 11, fx + 6, lawn_y - 10, '#cdbfa6')
    anchors_near = {'fountain': [fx, lawn_y - 12], 'lawn_y': lawn_y}
    for tx3 in list(range(40, 300, 70)) + list(range(470, near.w, 90)):
        tree(near, tx3 + rng.randint(-10, 10), lawn_y + 4, rng.randint(40, 60), rng, 0.0)
    # benches
    for bx3 in range(150, near.w, 260):
        near.rect(bx3, lawn_y + 12, bx3 + 14, lawn_y + 13, '#6b4a34')
        near.rect(bx3, lawn_y + 9, bx3 + 14, lawn_y + 10, '#6b4a34')
        near.rect(bx3 + 1, lawn_y + 14, bx3 + 1, lawn_y + 16, '#2d2a28')
        near.rect(bx3 + 13, lawn_y + 14, bx3 + 13, lawn_y + 16, '#2d2a28')
    save(near, 'j3_near.png', parallax=1.0, anchors=anchors_near)
    MANIFEST['j3'] = {'travel': travel}


def shot_high():
    """J4: high over the city — the awe beat. Scale 3 plate for a wider view."""
    travel = 360
    W0, H0 = 640, 360
    rng = random.Random(53)
    save(sky_plate(W0 + 40, H0, sun_xy=(200, 150), top='#9fbfca', mid='#ebe0cc', low='#f3cfa6'), 'j4_sky.png',
         parallax=0.02)
    layers = [
        ('j4_l1', 0.1, 0.8, 250, 20, 60, 8, 18, 0),
        ('j4_l2', 0.25, 0.62, 270, 30, 80, 10, 22, 0),
        ('j4_l3', 0.45, 0.42, 300, 30, 90, 12, 26, 1),
        ('j4_l4', 0.75, 0.2, 340, 40, 110, 16, 34, 2),
    ]
    for name, para, haze, base, hmin, hmax, wmin, wmax, det in layers:
        cv = skyline(W0 + int(travel * para) + 60, H0, base, rng, haze, hmin, hmax, wmin, wmax, det,
                     lit_p=0.12, landmarks=det < 2)
        if name == 'j4_l2':
            # the river snakes through the middle distance
            cv.rect(0, 272, cv.w, 282, hazed('#9fbcbc', 0.55))
        save(cv, name + '.png', parallax=para)
    MANIFEST['j4'] = {'travel': travel}


def brownstone(cv: Canvas, x, ground, w, h, rng: random.Random, face, anchors=None, key=None):
    top = ground - h
    light = mix(face, '#ffffff', 0.14)
    dark = mix(face, '#1b1a1f', 0.3)
    cv.rect(x, top, x + w - 1, ground, face)
    cv.rect(x, top, x, ground, light)
    cv.rect(x + w - 3, top, x + w - 1, ground, dark)
    cv.rect(x - 2, top - 3, x + w + 1, top, mix(face, '#fff4e0', 0.35))
    cv.rect(x - 2, top + 1, x + w + 1, top + 1, dark)
    # bay windows, 3 floors
    wins = []
    for fy in range(top + 8, ground - 26, 26):
        for c in range(3):
            wx = x + 6 + c * ((w - 12) // 3)
            ww = (w - 12) // 3 - 5
            cv.rect(wx - 1, fy - 1, wx + ww, fy + 15, mix(face, '#efe3cf', 0.6))
            draw_window(cv, wx, fy, ww, 14, rng, 0.0, 0.3, frame=False)
            cv.rect(wx + ww // 2, fy, wx + ww // 2, fy + 13, mix(face, '#efe3cf', 0.6))
            cv.rect(wx - 2, fy + 15, wx + ww + 1, fy + 16, mix(face, '#fff4e0', 0.4))
            # flower box
            if rng.random() < 0.45:
                cv.rect(wx - 1, fy + 17, wx + ww, fy + 18, '#6b4a34')
                for fxx in range(wx, wx + ww, 2):
                    cv.px(fxx, fy + 16, rng.choice(['#e98a6a', '#f2e3a1', '#7b9656', '#d45b52']))
            wins.append([wx, fy, ww, 14])
    # stoop and door
    dx = x + w // 2 - 5
    cv.rect(dx - 4, ground - 8, dx + 14, ground, mix(face, '#000000', 0.15))
    for i in range(4):
        cv.rect(dx - 4 + i, ground - 8 + i * 2, dx + 14 - i, ground - 8 + i * 2, mix(face, '#fff4e0', 0.2))
    cv.rect(dx, ground - 26, dx + 10, ground - 9, '#3a2a22')
    cv.rect(dx + 1, ground - 25, dx + 9, ground - 20, '#e8b977')
    if anchors is not None and key:
        anchors[key] = {'windows': wins, 'x': x, 'top': top, 'w': w}


def shot_residential():
    """J5: quiet tree-lined residential street; target window."""
    travel = 540
    W0, H0 = 480, 270
    rng = random.Random(71)
    anchors: dict = {}
    save(sky_plate(W0 + 60, H0, sun_xy=(420, 50), top='#abc8cf', mid='#eee3cf', low='#f3d9b8'), 'j5_sky.png',
         parallax=0.03)
    far = skyline(W0 + int(travel * 0.2) + 60, H0, 190, rng, 0.6, 30, 80, 14, 30, 0)
    save(far, 'j5_far.png', parallax=0.2)
    near = Canvas(W0 + travel + 160, H0)
    ground = 236
    x = -4
    i = 0
    faces = ['#a65a3f', '#8f4d39', '#b86a4a', '#9c6b54', '#7d5a4a', '#a8715a']
    while x < near.w:
        bw = rng.randint(62, 78)
        key = 'target' if i == 7 else None
        brownstone(near, x, ground, bw, rng.randint(150, 175), rng, rng.choice(faces), anchors, key)
        x += bw
        i += 1
    near.rect(0, ground + 1, near.w, ground + 10, SIDEWALK)
    near.rect(0, ground + 11, near.w, H0, ASPHALT)
    save(near, 'j5_near.png', parallax=1.0, anchors=anchors, ground=ground)
    fg = Canvas(W0 + int(travel * 1.35) + 160, H0)
    for tx in range(30, fg.w, 150):
        tree(fg, tx, H0 + 20, rng.randint(80, 100), rng, 0.0)
    save(fg, 'j5_fg.png', parallax=1.35)
    MANIFEST['j5'] = {'travel': travel}


# ================================================================== INTERIORS
def person_back(cv: Canvas, cx, base, s=1.0, hoodie='#3d4a52', hair='#2a211d'):
    """Seated person seen from behind (sender)."""
    m_body = Mask(cv.w, cv.h)
    m_body.ellipse(cx, base - int(18 * s), int(30 * s), int(26 * s))
    m_body.rect(cx - int(30 * s), base - int(18 * s), cx + int(30 * s), base)
    body = m_body.arr()
    cv.fill(body, hoodie)
    cv.fill(body & ~shift(body, 2, 0), mix(hoodie, '#f4c99e', 0.25))  # rim light from the window side
    head = Mask(cv.w, cv.h).ellipse(cx + int(2 * s), base - int(52 * s), int(15 * s), int(17 * s)).arr()
    neck = Mask(cv.w, cv.h).rect(cx - int(6 * s), base - int(40 * s), cx + int(8 * s), base - int(34 * s)).arr()
    cv.fill(neck, '#b98468')
    cv.fill(head, hair)
    cv.fill(head & ~shift(head, 2, 0), '#5a4033')
    # ear
    cv.rect(cx - int(13 * s), base - int(50 * s), cx - int(11 * s), base - int(45 * s), '#c7906f')
    # hood folds
    hood = Mask(cv.w, cv.h).ellipse(cx, base - int(36 * s), int(18 * s), int(6 * s)).arr() & body
    cv.fill(hood, mix(hoodie, '#000000', 0.2))


def shot_sender_room():
    """S1: interior at dawn — desk, laptop, big window, pigeon on the outer ledge."""
    W0, H0 = 640, 360  # scale 3
    rng = random.Random(5)
    anchors: dict = {}
    # outside view (through window)
    out = sky_plate(W0, H0, sun_xy=(470, 150), top='#b7cccc', mid='#f0dcc1', low='#f5c393')
    far = skyline(W0, H0, 250, rng, 0.7, 30, 90, 10, 26, 0, landmarks=True)
    mid = skyline(W0, H0, 290, rng, 0.42, 30, 110, 16, 34, 1, lit_p=0.2)
    out.paste(far, 0, 0)
    out.paste(mid, 0, 0)
    save(out, 's1_outside.png')
    # the room with a transparent window hole
    room = Canvas(W0, H0)
    wall = dither_gradient(W0, H0, [(0, '#3a302a'), (0.6, '#4a3b31'), (1, '#2d2521')])
    room.a[:] = wall.a
    wx0, wy0, wx1, wy1 = 250, 40, 600, 250
    room.a[wy0:wy1, wx0:wx1] = 0
    # frame + mullions
    fc, fcl = '#e9dcc4', '#fff3de'
    room.rect(wx0 - 6, wy0 - 6, wx1 + 5, wy0 - 1, fc)
    room.rect(wx0 - 6, wy0 - 6, wx0 - 1, wy1 + 5, fc)
    room.rect(wx1, wy0 - 6, wx1 + 5, wy1 + 5, '#cbbd a6'.replace(' ', ''))
    room.rect((wx0 + wx1) // 2 - 2, wy0, (wx0 + wx1) // 2 + 2, wy1, fc)
    room.rect(wx0, (wy0 + wy1) // 2 - 2, wx1, (wy0 + wy1) // 2 + 2, fc)
    room.rect(wx0 - 12, wy1, wx1 + 11, wy1 + 7, fcl)  # inner sill
    room.rect(wx0 - 12, wy1 + 8, wx1 + 11, wy1 + 9, '#b9a88d')
    anchors['window'] = [wx0, wy0, wx1, wy1]
    anchors['ledge'] = [548, wy1 - 1]  # outer ledge, where the pigeon sits (behind glass, bottom right pane)
    # hanging plant on the left + framed print
    room.rect(70, 70, 150, 150, '#d9c7a6')
    room.rect(76, 76, 144, 144, '#6f8f86')
    room.fill(Mask(W0, H0).ellipse(128, 104, 9, 9).arr(), '#f4e3c3')
    room.fill(Mask(W0, H0).ellipse(96, 150, 44, 22).arr() & (np.arange(H0)[:, None] < 145), '#dda77a')
    room.fill(Mask(W0, H0).ellipse(136, 156, 40, 22).arr() & (np.arange(H0)[:, None] < 145), '#b8845e')
    # desk
    desk_y = 282
    room.rect(0, desk_y, W0, desk_y + 6, '#8a5e3f')
    room.rect(0, desk_y, W0, desk_y, '#b07b55')
    room.rect(0, desk_y + 7, W0, H0, '#5a3d2b')
    # laptop (screen facing the person, we see it from behind their shoulder)
    lx, ly = 300, 196
    room.rect(lx - 6, desk_y - 3, lx + 150, desk_y - 1, '#b8b3ab')  # base
    room.rect(lx, ly, lx + 144, desk_y - 4, '#d9d4cc')  # lid bezel
    room.rect(lx + 4, ly + 4, lx + 140, desk_y - 8, '#f6f3ee')  # screen (UI composited in Remotion)
    anchors['screen'] = [lx + 4, ly + 4, 136, desk_y - 8 - (ly + 4)]
    # mug with steam anchor
    room.rect(470, desk_y - 20, 484, desk_y - 1, '#e9dcc4')
    room.rect(484, desk_y - 15, 488, desk_y - 8, '#e9dcc4')
    room.rect(470, desk_y - 20, 484, desk_y - 19, '#fff3de')
    anchors['steam'] = [477, desk_y - 22]
    # desk lamp
    room.rect(600, desk_y - 4, 630, desk_y - 1, '#2d2a28')
    room.rect(612, desk_y - 60, 614, desk_y - 4, '#2d2a28')
    room.rect(598, desk_y - 70, 628, desk_y - 60, '#dda77a')
    # books
    for i, c in enumerate(['#6f8f86', '#c65a43', '#e9dcc4', '#3b4a6b']):
        room.rect(40, desk_y - 8 - i * 6, 110 - i * 5, desk_y - 3 - i * 6, c)
    # potted plant
    room.rect(170, desk_y - 22, 196, desk_y - 1, '#c07c5b')
    tree(room, 183, desk_y - 22, 26, rng, 0.0)
    save(room, 's1_room.png', anchors=anchors)
    person = Canvas(W0, H0)
    person_back(person, 215, H0 + 34, s=2.5)
    save(person, 's1_person.png')


def facade_window_scene(prefix: str, face: str, interior_cb, seed: int):
    """Exterior close-up at scale 6 (320x180): brick facade, window, stone ledge."""
    W0, H0 = 320, 180
    rng = random.Random(seed)
    anchors: dict = {}
    cv = Canvas(W0, H0)
    # brick wall
    cv.rect(0, 0, W0, H0, face)
    for by in range(0, H0, 4):
        off = 0 if (by // 4) % 2 == 0 else 5
        for bx in range(-off, W0, 10):
            cv.rect(bx, by, bx, by + 3, mix(face, '#000000', 0.18))
            if rng.random() < 0.25:
                cv.rect(bx + 1, by, bx + 9, by + 2, mix(face, rng.choice(['#ffffff', '#000000']), 0.07))
        cv.rect(0, by + 3, W0, by + 3, mix(face, '#000000', 0.22))
    wx0, wy0, wx1, wy1 = 34, 18, 206, 138
    interior = interior_cb(wx1 - wx0, wy1 - wy0, rng, anchors)
    cv.a[wy0:wy1, wx0:wx1] = interior.a
    # glass reflection streaks
    for i in range(0, 40):
        x = wx0 + 20 + i
        y0 = wy0 + i
        if 0 <= i < 40:
            cv.fill(Mask(W0, H0).line([(x, wy0), (x - 30, wy1)], 1).arr() & (np.arange(W0)[None, :] >= wx0), (255, 255, 255, 14))
    # frame
    fc = '#efe4d0'
    cv.rect(wx0 - 4, wy0 - 4, wx1 + 3, wy0 - 1, fc)
    cv.rect(wx0 - 4, wy0 - 4, wx0 - 1, wy1, fc)
    cv.rect(wx1, wy0 - 4, wx1 + 3, wy1, '#d3c6ae')
    cv.rect((wx0 + wx1) // 2 - 1, wy0, (wx0 + wx1) // 2 + 1, wy1, fc)
    # lintel
    cv.rect(wx0 - 8, wy0 - 10, wx1 + 7, wy0 - 5, '#d8c7a8')
    cv.rect(wx0 - 8, wy0 - 10, wx1 + 7, wy0 - 10, '#efe2c8')
    # stone ledge
    ly = wy1
    cv.rect(wx0 - 12, ly, wx1 + 11, ly + 7, '#d8c7a8')
    cv.rect(wx0 - 12, ly, wx1 + 11, ly + 1, '#f1e6d0')
    cv.rect(wx0 - 12, ly + 7, wx1 + 11, ly + 9, '#9d8d73')
    anchors['window'] = [wx0, wy0, wx1, wy1]
    anchors['ledge_y'] = ly
    # right side: building edge revealing sky/city
    edge = 262
    sky = sky_plate(W0 - edge, H0, None, top='#b3cbcd', mid='#efdfc6', low='#f4cfa4')
    cv.a[:, edge:] = sky.a
    far = skyline(W0 - edge, H0, 170, rng, 0.55, 40, 120, 8, 18, 0)
    sub = Canvas(W0 - edge, H0)
    sub.a[:] = cv.a[:, edge:]
    sub.paste(far, 0, 0)
    cv.a[:, edge:] = sub.a
    cv.rect(edge - 3, 0, edge - 1, H0, mix(face, '#000000', 0.35))
    anchors['edge'] = edge
    save(cv, prefix + '_facade.png', anchors=anchors)


def interior_sender(w, h, rng, anchors):
    cv = dither_gradient(w, h, [(0, '#3d322b'), (1, '#2b231f')])
    # warm lamp at the back right
    cv.rect(128, 34, 146, 58, '#f4d9a8')
    cv.rect(128, 34, 146, 35, '#fff0cf')
    cv.rect(135, 58, 138, h - 27, '#2d2a28')
    px_ = 50
    # person behind the laptop, lit by it
    body = Mask(w, h).ellipse(px_, h - 26, 37, 22).arr()
    cv.fill(body, '#3d4a52')
    cv.fill(body & ~shift(body, 0, 2), '#556570')
    neck = Mask(w, h).rect(px_ - 5, h - 56, px_ + 5, h - 46).arr()
    cv.fill(neck, '#a8765b')
    head = Mask(w, h).ellipse(px_, h - 66, 12, 14).arr()
    cv.fill(head, '#c28c6c')
    hair = Mask(w, h).ellipse(px_, h - 74, 13, 9).arr() & (np.arange(h)[:, None] < h - 69)
    cv.fill(hair, '#2a211d')
    cv.fill(Mask(w, h).rect(px_ - 13, h - 76, px_ - 11, h - 62).arr(), '#2a211d')
    cv.px(px_ - 5, h - 64, '#2a211d'); cv.px(px_ + 5, h - 64, '#2a211d')
    cv.rect(px_ - 2, h - 57, px_ + 2, h - 57, '#9b6a52')
    anchors['face'] = [px_, h - 64]
    # desk in front of the body
    cv.rect(0, h - 26, w, h, '#6b4a34')
    cv.rect(0, h - 26, w, h - 25, '#8a5e3f')
    # laptop back
    cv.rect(px_ - 30, h - 52, px_ + 30, h - 27, '#c9c3ba')
    cv.rect(px_ - 30, h - 52, px_ + 30, h - 51, '#e4ded4')
    cv.fill(Mask(w, h).ellipse(px_, h - 40, 3, 3).arr(), '#b2aca3')
    anchors['glow'] = [px_, h - 60]
    return cv


def interior_recipient(w, h, rng, anchors):
    cv = dither_gradient(w, h, [(0, '#4a4038'), (1, '#322a24')])
    # shelves + plants in the back
    cv.rect(96, 22, 156, 24, '#8a5e3f')
    for i, c in enumerate(['#6f8f86', '#c65a43', '#e9dcc4', '#3b4a6b', '#d49a3a']):
        cv.rect(100 + i * 7, 10, 105 + i * 7, 21, c)
    tree(cv, 150, 62, 22, rng, 0.0)
    cv.rect(142, 62, 158, 74, '#c07c5b')
    px_ = 48
    body = Mask(w, h).ellipse(px_, h - 22, 37, 23).arr()
    cv.fill(body, '#c9785a')
    cv.fill(body & ~shift(body, 0, 2), '#dc9274')
    neck = Mask(w, h).rect(px_ - 4, h - 52, px_ + 4, h - 44).arr()
    cv.fill(neck, '#94603f')
    head = Mask(w, h).ellipse(px_, h - 64, 12, 14).arr()
    hair_back = Mask(w, h).ellipse(px_, h - 60, 16, 19).arr() & (np.arange(h)[:, None] < h - 44)
    cv.fill(hair_back & ~head, '#1f1a18')
    cv.fill(head, '#a86f52')
    fringe = Mask(w, h).ellipse(px_ + 2, h - 75, 13, 7).arr() & (np.arange(h)[:, None] < h - 71)
    cv.fill(fringe, '#1f1a18')
    anchors['eyes'] = [[px_ - 5, h - 64], [px_ + 5, h - 64]]
    cv.px(px_ - 5, h - 64, '#1f1a18'); cv.px(px_ + 5, h - 64, '#1f1a18')
    cv.rect(px_ - 2, h - 57, px_ + 2, h - 57, '#7e4b3a')
    anchors['face'] = [px_, h - 64]
    # table in front
    cv.rect(0, h - 22, w, h, '#8a5e3f')
    cv.rect(0, h - 22, w, h - 21, '#b07b55')
    # laptop back, facing us
    cv.rect(px_ - 30, h - 48, px_ + 30, h - 23, '#d2cdc5')
    cv.rect(px_ - 30, h - 48, px_ + 30, h - 47, '#ebe6de')
    cv.fill(Mask(w, h).ellipse(px_, h - 36, 3, 3).arr(), '#bdb7ae')
    anchors['glow'] = [px_, h - 58]
    # mug
    cv.rect(96, h - 34, 106, h - 23, '#6f8f86')
    cv.rect(106, h - 31, 109, h - 26, '#6f8f86')
    anchors['steam'] = [101, h - 36]
    return cv


# ================================================================== SPRITES
def person_sprite_strip(rng: random.Random, n=10):
    """n pedestrians x 4 walk frames, each 8x18."""
    cw, ch = 8, 18
    img = Canvas(cw * 4, ch * n)
    skins = ['#f1c7a5', '#d9a07e', '#b07a5a', '#8a5a40', '#6b4331']
    hairs = ['#2a211d', '#5a3a26', '#c9a26b', '#1a1a1a', '#8b4a2b', '#d8d2c6']
    tops = ['#c65a43', '#2f6a63', '#d49a3a', '#3b4a6b', '#e9dcc4', '#6f8f86', '#7d4a6a', '#40464f', '#dda77a']
    bottoms = ['#2d3440', '#4a4640', '#3b4a6b', '#6b5a48', '#1f1f24']
    for i in range(n):
        skin, hair, top, bot = rng.choice(skins), rng.choice(hairs), rng.choice(tops), rng.choice(bottoms)
        coat = rng.random() < 0.4
        bag = rng.random() < 0.3
        for f in range(4):
            ox, oy = f * cw, i * ch
            bob = 1 if f in (1, 3) else 0
            # head
            img.rect(ox + 3, oy + 1 + bob, ox + 5, oy + 3 + bob, skin)
            img.rect(ox + 3, oy + 0 + bob, ox + 5, oy + 1 + bob, hair)
            img.px(ox + 2, oy + 1 + bob, hair)
            # torso
            img.rect(ox + 2, oy + 4 + bob, ox + 5, oy + (11 if coat else 9) + bob, top)
            img.rect(ox + 2, oy + 4 + bob, ox + 2, oy + 9 + bob, mix(top, '#ffffff', 0.2))
            if bag:
                img.rect(ox + 5, oy + 7 + bob, ox + 6, oy + 9 + bob, '#6b4a34')
            # legs
            legs = [(0, 0), (1, -1), (0, 0), (-1, 1)][f]
            ly = oy + (12 if coat else 10) + bob
            img.rect(ox + 3 + legs[0], ly, ox + 3 + legs[0], oy + 16, bot)
            img.rect(ox + 4 + legs[1], ly, ox + 4 + legs[1], oy + 16, mix(bot, '#000000', 0.2))
            img.px(ox + 3 + legs[0], oy + 17, '#1f1a18')
            img.px(ox + 4 + legs[1], oy + 17, '#1f1a18')
    img.save(os.path.join(OUT, 'people.png'))
    MANIFEST['people'] = {'cw': cw, 'ch': ch, 'n': n, 'frames': 4}


def vehicles():
    rng = random.Random(3)
    # cars: 6 variants, each 30x13
    cw, ch = 30, 13
    cars = Canvas(cw, ch * 6)
    for i, col in enumerate(['#c65a43', '#2f6a63', '#e9dcc4', '#3b4a6b', '#d49a3a', '#40464f']):
        oy = i * ch
        cars.rect(1, oy + 5, 28, oy + 10, col)
        cars.rect(6, oy + 1, 21, oy + 5, col)
        cars.rect(8, oy + 2, 13, oy + 5, '#b7c9cc')
        cars.rect(15, oy + 2, 19, oy + 5, '#b7c9cc')
        cars.rect(1, oy + 5, 28, oy + 5, mix(col, '#ffffff', 0.25))
        cars.rect(1, oy + 9, 28, oy + 9, mix(col, '#000000', 0.3))
        cars.rect(27, oy + 6, 28, oy + 7, '#fbe6a0')
        cars.rect(1, oy + 6, 1, oy + 7, '#d6453a')
        for wx in (6, 22):
            cars.rect(wx - 2, oy + 9, wx + 2, oy + 12, '#1f1d1c')
            cars.px(wx, oy + 10, '#8d8a86')
    cars.save(os.path.join(OUT, 'cars.png'))
    MANIFEST['cars'] = {'cw': cw, 'ch': ch, 'n': 6}
    # tram 110x30
    tram = Canvas(112, 34)
    tram.rect(2, 6, 109, 27, '#d49a3a')
    tram.rect(2, 20, 109, 27, '#2f6a63')
    tram.rect(2, 6, 109, 7, '#f0c26b')
    for wx in range(8, 104, 12):
        tram.rect(wx, 10, wx + 8, 17, '#f7dfa8')
        tram.rect(wx, 10, wx + 8, 11, '#fff3d0')
        # passengers
        if rng.random() < 0.7:
            tram.rect(wx + 3, 13, wx + 5, 17, rng.choice(['#3b4a6b', '#c65a43', '#40464f', '#6f8f86']))
            tram.rect(wx + 3, 11, wx + 5, 12, rng.choice(['#f1c7a5', '#b07a5a', '#8a5a40']))
    tram.rect(30, 0, 31, 5, '#2b2724')
    tram.rect(26, 0, 40, 0, '#2b2724')
    for wx in (16, 26, 86, 96):
        tram.rect(wx - 3, 28, wx + 3, 33, '#1f1d1c')
    tram.rect(106, 12, 109, 15, '#fbe6a0')
    tram.save(os.path.join(OUT, 'tram.png'))
    MANIFEST['tram'] = {'w': 112, 'h': 34}
    # boat 40x14
    boat = Canvas(44, 18)
    boat.rect(2, 10, 41, 14, '#c65a43')
    boat.rect(5, 15, 38, 16, '#8f3e2c')
    boat.rect(2, 10, 41, 10, '#e98a6a')
    boat.rect(12, 4, 30, 9, '#f1e4cf')
    for wx in range(14, 29, 4):
        boat.rect(wx, 6, wx + 1, 7, '#56697a')
    boat.rect(22, 0, 23, 3, '#2d2a28')
    boat.save(os.path.join(OUT, 'boat.png'))
    MANIFEST['boat'] = {'w': 44, 'h': 18}
    # kite 9x9 + tail
    kite = Canvas(10, 10)
    kite.fill(Mask(10, 10).poly([(5, 0), (9, 4), (5, 9), (1, 4)]).arr(), '#c65a43')
    kite.fill(Mask(10, 10).poly([(5, 0), (9, 4), (5, 4)]).arr(), '#f0c26b')
    kite.save(os.path.join(OUT, 'kite.png'))
    # clouds
    for i in range(4):
        c = cloud(rng.randint(60, 110), rng.randint(18, 28), random.Random(100 + i))
        save(c, f'cloud{i}.png')
    # envelope (pixel) 12x9
    env = Canvas(14, 10)
    env.rect(0, 0, 13, 9, '#1d1b1a')
    env.rect(1, 1, 12, 8, '#f4f0e8')
    for i in range(6):
        env.px(1 + i, 1 + i // 1 if i < 4 else 4, '#c9bfae')
    env.fill(Mask(14, 10).line([(1, 1), (6, 5), (12, 1)]).arr(), '#b8ab96')
    env.rect(6, 5, 7, 6, '#dda77a')
    env.save(os.path.join(OUT, 'envelope.png'))
    MANIFEST['envelope'] = {'w': 14, 'h': 10}


if __name__ == '__main__':
    shot_sender_room()
    facade_window_scene('s3', '#a65a3f', interior_sender, 8)
    shot_rooftops()
    shot_street()
    shot_park()
    shot_high()
    shot_residential()
    facade_window_scene('r1', '#9c6b54', interior_recipient, 9)
    person_sprite_strip(random.Random(4), 12)
    vehicles()
    with open(os.path.join(ROOT, 'src', 'art-manifest.json'), 'w') as f:
        json.dump(MANIFEST, f, indent=1)
    print('ok', len(MANIFEST))
