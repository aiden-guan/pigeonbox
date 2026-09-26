"""Hazards for the fast middle of the film: an airliner, a hawk, a thunderstorm.

Writes to public/art and merges entries into src/art-manifest.json.
Run after gen_world.py: python3 scripts/gen_hazards.py
"""
from __future__ import annotations

import json
import os
import random

import numpy as np
from PIL import Image

from gen_world import building, dither_gradient, skyline
from pixelkit import Canvas, Mask, mix, outline, rot, shade, shift

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'art')
MAN = os.path.join(ROOT, 'src', 'art-manifest.json')
manifest = json.load(open(MAN))

INK = '#1d1b1a'


def save(cv: Canvas | Image.Image, name: str, **meta):
    img = cv.image() if isinstance(cv, Canvas) else cv
    img.save(os.path.join(OUT, name))
    manifest[name.replace('.png', '')] = {'w': img.width, 'h': img.height, **meta}


# ------------------------------------------------------------------ airliner
def airliner():
    W, H = 264, 84
    cv = Canvas(W, H)
    yy, xx = np.mgrid[0:H, 0:W]
    fus = Mask(W, H).rect(30, 30, 232, 50).ellipse(232, 40, 16, 10).poly([(30, 30), (8, 22), (6, 30), (30, 50)]).arr()
    fin = Mask(W, H).poly([(12, 26), (2, 2), (16, 2), (44, 30)]).arr()
    stab = Mask(W, H).poly([(18, 34), (0, 42), (10, 43), (40, 38)]).arr()
    wing = Mask(W, H).poly([(112, 45), (158, 47), (108, 76), (96, 76)]).arr()
    nacelle = Mask(W, H).ellipse(136, 58, 15, 6).arr()
    gear = Mask(W, H).rect(127, 62, 129, 72).rect(214, 50, 216, 68).arr()
    wheels = Mask(W, H).ellipse(124, 75, 3, 3).ellipse(132, 75, 3, 3).ellipse(215, 70, 3, 3).arr()
    sil = fus | fin | stab | wing | nacelle | gear | wheels
    # far wing peeking above the fuselage
    far = Mask(W, H).poly([(120, 31), (150, 31), (132, 22), (126, 22)]).arr()
    cv.fill(far & ~fus, '#b9b2a6')
    shade(cv, fin, '#2f6a63', '#4f8f86', '#1f4a46', band_dark=0.8)
    cv.fill(fin & (yy > 10) & (yy < 14), '#dda77a')
    shade(cv, stab, '#e4ddd0', '#f6f2ea', '#b9b2a6')
    shade(cv, fus, '#efe9dd', '#fbf8f2', '#cfc8bb', band_light=0.2, band_dark=0.7)
    cv.fill(fus & (yy >= 46), '#bdb6aa')
    # cheatline: copper over teal
    cv.fill(fus & (yy == 42) & (xx > 20), '#dda77a')
    cv.fill(fus & (yy == 43) & (xx > 20), '#2f6a63')
    # passenger windows
    for x in range(58, 214, 5):
        cv.rect(x, 36, x + 1, 37, '#3b4250')
    # doors
    for x in (52, 150, 212):
        cv.rect(x, 33, x, 41, '#bdb6aa')
        cv.rect(x + 4, 33, x + 4, 41, '#bdb6aa')
    # cockpit
    cv.fill(Mask(W, H).poly([(232, 34), (240, 34), (244, 37), (232, 37)]).arr(), '#2d3440')
    cv.px(239, 35, '#9fb6c4')
    shade(cv, wing, '#d8d1c4', '#ece6db', '#a9a295')
    cv.fill(wing & (xx + (yy - 45) * 0.5 < 104), '#9d968a')  # flaps
    shade(cv, nacelle, '#5a5e66', '#7a7f88', '#3a3d44', band_light=0.3)
    cv.fill(Mask(W, H).ellipse(150, 58, 2, 5).arr(), '#2a2c31')
    cv.fill(gear, '#4a4d54')
    cv.fill(wheels, '#1f2024')
    for x, y in ((124, 75), (132, 75), (215, 70)):
        cv.px(x, y, '#8d8f94')
    outline(cv, sil | (far & ~fus), '#2a2826')
    # beacon (animated in Remotion as a separate dot)
    save(cv, 'jet.png', beacon=[118, 26], engine=[122, 58], gear=[128, 76])


# ---------------------------------------------------------------------- hawk
HB = '#7a5234'
HB_L = '#9a6e48'
HB_D = '#4a3020'
CREAM = '#eadcc0'
CREAM_D = '#cdb892'
RUFOUS = '#b8643a'
YEL = '#e8c04a'


def hawk_wing(angle, spread, sx=44, sy=27):
    L = 34 * spread
    base = [(sx, sy), (sx - 9, sy - 3), (sx - 20, sy - 4), (sx - L, sy - 2),
            (sx - L + 2, sy + 1), (sx - L + 5, sy), (sx - L + 6, sy + 3), (sx - L + 9, sy + 2), (sx - L + 10, sy + 5),
            (sx - L + 14, sy + 5), (sx - 14, sy + 8), (sx - 6, sy + 8), (sx - 1, sy + 5)]
    return rot(base, sx, sy, -angle)


def hawk_frame(angle, spread, bob, dive=False):
    W, H = 88, 64
    cv = Canvas(W, H)
    oy = bob + 8
    yy, xx = np.mgrid[0:H, 0:W]
    if dive:
        near_pts = [(x, y + oy - 6) for x, y in hawk_wing(70, 0.8)]
        far_pts = [(x + 3, y + oy - 8) for x, y in hawk_wing(78, 0.75)]
    else:
        near_pts = [(x, y + oy) for x, y in hawk_wing(angle, spread)]
        far_pts = [(x + 3, y + oy - 3) for x, y in hawk_wing(angle - 8, spread * 0.92)]
    far = Mask(W, H).poly(far_pts).arr()
    body = Mask(W, H).ellipse(42, 30 + oy, 15, 7).arr()
    head = Mask(W, H).ellipse(59, 25 + oy, 7, 6).arr()
    neck = Mask(W, H).poly([(50, 23 + oy), (58, 19 + oy), (61, 30 + oy), (52, 35 + oy)]).arr()
    tail = Mask(W, H).poly([(30, 27 + oy), (19, 23 + oy), (15, 28 + oy), (15, 33 + oy), (19, 38 + oy), (30, 34 + oy)]).arr()
    beak = Mask(W, H).poly([(64, 23 + oy), (69, 25 + oy), (68, 29 + oy), (65, 27 + oy)]).arr()
    near = Mask(W, H).poly(near_pts).arr()
    if dive:
        legs = Mask(W, H).line([(46, 35 + oy), (56, 42 + oy)], 2).arr()
        claws = Mask(W, H).poly([(55, 41 + oy), (61, 43 + oy), (58, 46 + oy), (54, 44 + oy)]).arr()
    else:
        legs = Mask(W, H).rect(36, 36 + oy, 39, 37 + oy).arr()
        claws = np.zeros_like(legs)
    sil = far | body | head | neck | tail | beak | near | legs | claws
    cv.fill(far, HB_D)
    cv.fill(far & ~shift(far, 0, 1), HB)
    shade(cv, tail, RUFOUS, '#cf7c4f', '#8a4526')
    cv.fill(tail & (xx < 18), HB_D)
    cv.fill(tail & (xx == 21), HB_D)
    torso = body | neck | head
    shade(cv, torso, HB, HB_L, HB_D, band_light=0.15, band_dark=0.75)
    belly = torso & (yy > 30 + oy + (58 - xx) * 0.15) & (xx > 36)
    cv.fill(belly, CREAM)
    streaks = belly & ((xx + yy) % 4 == 0) & (yy > 32 + oy)
    cv.fill(streaks, CREAM_D)
    cv.fill(streaks & (xx % 3 == 0), HB)
    cv.fill(head & (yy < 23 + oy), HB_D)
    cv.fill(legs, YEL)
    cv.fill(claws, '#3a2a1c')
    dist = np.hypot(xx - 44, yy - (27 + oy)) / (34 * (0.8 if dive else spread))
    cv.fill(near, HB)
    cv.fill(near & (dist < 0.4), HB_L)
    cv.fill(near & (dist > 0.62), HB_D)
    bars = near & (dist > 0.62) & ((xx + 2 * yy) % 5 == 0)
    cv.fill(bars, '#2e1e14')
    lead = near & ~shift(near, 0, 1)
    cv.fill(lead & (dist < 0.62), '#b88a60')
    shade(cv, beak, YEL, '#f2d67a', '#b8932f', rim_dark=False)
    cv.fill(beak & (xx >= 67), '#2a2420')
    # fierce eye with brow
    cv.px(62, 23 + oy, '#f2c94c'); cv.px(63, 23 + oy, INK); cv.px(62, 24 + oy, INK); cv.px(63, 24 + oy, INK)
    cv.rect(60, 22 + oy, 64, 22 + oy, '#2e1e14')
    outline(cv, sil, INK)
    return cv


def hawk():
    frames = [(-62, 1.2, 1, False), (-20, 1.28, 0, False), (28, 1.12, -1, False), (-4, 0.98, 0, False), (0, 1, 0, True)]
    strip = Image.new('RGBA', (88 * 5, 64))
    for i, (a, s, b, d) in enumerate(frames):
        strip.alpha_composite(hawk_frame(a, s, b, d).image(), (i * 88, 0))
    save(strip, 'hawk.png', cw=88, ch=64)


# --------------------------------------------------------------------- storm
def darken_to_storm(cv: Canvas, amount=0.62):
    a = cv.a.astype(np.float32)
    rgb = a[..., :3]
    warm = (rgb[..., 0] > 200) & (rgb[..., 1] > 150) & (rgb[..., 2] < 150)  # lit windows stay lit
    storm = np.array([58, 62, 76], np.float32)
    dark = rgb * (1 - amount) + storm * amount * (rgb / 255 * 0.7 + 0.3)
    rgb[~warm] = dark[~warm]
    rgb[warm] = rgb[warm] * 0.95
    a[..., :3] = rgb
    cv.a = a.clip(0, 255).astype(np.uint8)
    return cv


def storm_clouds(w, h, rng, base_y, color, light, dark, count=40, rmin=12, rmax=40):
    cv = Canvas(w, h)
    m = Mask(w, h)
    for _ in range(count):
        r = rng.randint(rmin, rmax)
        m.ellipse(rng.randint(0, w), base_y + rng.randint(-r // 2, r // 3), int(r * 1.6), r)
    m.rect(0, 0, w, base_y)
    a = m.arr()
    cv.fill(a, color)
    cv.fill(a & ~shift(a, 0, 3) & ~shift(a, 0, -60), dark)
    cv.fill(a & ~shift(a, 0, -3), light)
    return cv


def storm():
    travel = 620
    W0, H0 = 480, 270
    rng = random.Random(91)
    sky = dither_gradient(W0 + 60, H0, [(0, '#2a2e39'), (0.55, '#434752'), (1.0, '#6a6660')])
    save(sky, 'st_sky.png', parallax=0.02)
    far = storm_clouds(W0 + int(travel * 0.12) + 120, H0, rng, 70, '#353a46', '#4a505d', '#2a2e38', 50, 14, 40)
    save(far, 'st_cfar.png', parallax=0.12)
    city = skyline(W0 + int(travel * 0.35) + 60, H0, 245, rng, 0.2, 40, 130, 14, 34, 1, lit_p=0.35, landmarks=True)
    save(darken_to_storm(city, 0.78), 'st_city.png', parallax=0.35)
    near = Canvas(W0 + travel + 120, H0)
    x = -4
    anchors = {'rods': []}
    while x < near.w:
        bw = rng.randint(40, 80)
        bh = rng.randint(30, 90)
        top = building(near, x, H0 + 8, bw, bh, rng, 0.0, 0.4, 3)
        if rng.random() < 0.45:
            h = rng.randint(14, 26)
            near.rect(x + bw // 2, top - h, x + bw // 2, top - 1, '#3a3836')
            anchors['rods'].append([x + bw // 2, top - h])
        x += bw + rng.randint(0, 5)
    save(darken_to_storm(near, 0.7), 'st_near.png', parallax=1.0, anchors=anchors)
    low = storm_clouds(W0 + int(travel * 1.7) + 200, H0, rng, 30, '#2b2f3a', '#3b404c', '#20232b', 30, 16, 36)
    save(low, 'st_clow.png', parallax=1.7)
    manifest['storm'] = {'travel': travel}


if __name__ == '__main__':
    airliner()
    hawk()
    storm()
    json.dump(manifest, open(MAN, 'w'), indent=1)
    print('ok')
