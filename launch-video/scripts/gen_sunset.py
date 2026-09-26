"""The closing shot: a skyscraper rooftop at sunset, the pigeon among friends.

Writes sunset plates and pigeon-friend sprites to public/art and merges them
into src/art-manifest.json. Run after gen_world.py.
"""
from __future__ import annotations

import colorsys
import json
import os
import random

import numpy as np
from PIL import Image

from gen_world import BAYER, building, cloud, dither_gradient, skyline
from pixelkit import Canvas, Mask, hexc, mix, shift

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'art')
MAN = os.path.join(ROOT, 'src', 'art-manifest.json')
manifest = json.load(open(MAN))
W0, H0 = 480, 270


def save(img, name, **meta):
    img = img.image() if isinstance(img, Canvas) else img
    img.save(os.path.join(OUT, name))
    manifest[name.replace('.png', '')] = {'w': img.width, 'h': img.height, **meta}


def dusk_tint(cv: Canvas, shadow: str, light: str, keep_lit=True, lit_boost=1.0):
    """Remap a daylight plate onto a sunset ramp by luminance; lit windows stay warm."""
    a = cv.a.astype(np.float32)
    rgb = a[..., :3]
    lum = (rgb[..., 0] * 0.3 + rgb[..., 1] * 0.59 + rgb[..., 2] * 0.11) / 255
    lit = (rgb[..., 0] > 200) & (rgb[..., 1] > 150) & (rgb[..., 2] < 150)
    s = np.array(hexc(shadow)[:3], np.float32)
    l = np.array(hexc(light)[:3], np.float32)
    t = np.clip(lum, 0, 1)[..., None] ** 1.2
    out = s * (1 - t) + l * t
    if keep_lit:
        out[lit] = np.clip(np.array([255, 196, 120], np.float32) * lit_boost, 0, 255)
    a[..., :3] = out
    cv.a = a.clip(0, 255).astype(np.uint8)
    return cv


def sky():
    SW = W0 + 40
    cv = dither_gradient(SW, H0, [(0, '#2e2344'), (0.3, '#7a3160'), (0.55, '#d24f5e'), (0.74, '#ec7f63'), (0.9, '#f8ae7a'), (1.0, '#fcd198')])
    sx, sy = 240, 184
    yy, xx = np.mgrid[0:H0, 0:SW]
    d = np.hypot(xx - sx, (yy - sy) * 1.2)
    thr = BAYER[yy % 4, xx % 4]
    for r, c, strength in [(190, '#f39a74', 0.45), (120, '#f9b47e', 0.6), (70, '#fcca8f', 0.75)]:
        t = np.clip(1 - d / r, 0, 1) * strength
        cv.fill((t > thr) & (d < r), c)
    sun = d < 34
    cv.fill(sun, '#ffe2b0')
    cv.fill(sun & (yy > sy + 8), '#ffd29a')
    # long, thin sunset cloud bands with lit undersides
    rng = random.Random(5)
    for band_y, n, col, lit in [(62, 5, '#7a3a63', '#d8707a'), (104, 6, '#9a4466', '#f08b78'), (150, 4, '#b8526a', '#f7a37f')]:
        for _ in range(n):
            w = rng.randint(50, 130)
            x = rng.randint(-20, W0 - 20)
            y = band_y + rng.randint(-10, 10)
            m = Mask(SW, H0)
            m.ellipse(x + w // 2, y, w // 2, 3)
            for k in range(3):
                m.ellipse(x + rng.randint(8, w - 8), y - rng.randint(1, 3), rng.randint(10, 22), 3)
            a = m.arr()
            cv.fill(a, col)
            cv.fill(a & ~shift(a, 0, -1), lit)
    save(cv, 'ss_sky.png', sun=[sx, sy], parallax=0.02)


def city():
    rng = random.Random(77)
    far = skyline(W0 + 60, H0, 236, rng, 0.0, 30, 110, 10, 26, 0, landmarks=True)
    save(dusk_tint(far, '#7c3c5c', '#c56a6e', lit_boost=0.9), 'ss_far.png', parallax=0.15)
    mid = skyline(W0 + 80, H0, 262, rng, 0.0, 30, 120, 16, 34, 1, lit_p=0.45)
    save(dusk_tint(mid, '#4a2640', '#9c4a5e'), 'ss_mid.png', parallax=0.35)


def rooftop():
    """The skyscraper roof the pigeons sit on: parapet, water tower, antenna."""
    cv = Canvas(W0 + 40, H0)
    top = 214
    body = '#35203a'
    cv.rect(0, top, cv.w, H0, body)
    # the building face below the parapet: a few warm windows
    rng = random.Random(3)
    for y in range(top + 16, H0, 10):
        for x in range(8, cv.w - 8, 12):
            if rng.random() < 0.35:
                cv.rect(x, y, x + 5, y + 5, rng.choice(['#ffc478', '#f7b066', '#ffd690']))
            else:
                cv.rect(x, y, x + 5, y + 5, '#2a1830')
    # parapet cap with sunset rim light
    cv.rect(0, top, cv.w, top + 6, '#4a2c48')
    cv.rect(0, top, cv.w, top, '#f2a07c')
    cv.rect(0, top + 1, cv.w, top + 1, '#c8687a')
    cv.rect(0, top + 7, cv.w, top + 8, '#231428')
    # water tower + antenna on the right, silhouetted
    wx = 410
    cv.rect(wx, top - 44, wx + 26, top - 16, '#2a1830')
    cv.rect(wx, top - 44, wx + 26, top - 44, '#e88c78')
    for i in range(6):
        cv.rect(wx - 2 + i, top - 50 + i, wx + 28 - i, top - 50 + i, '#2a1830')
    for lx in (wx + 3, wx + 22):
        cv.rect(lx, top - 16, lx + 1, top - 1, '#2a1830')
    cv.rect(wx + 3, top - 10, wx + 23, top - 9, '#2a1830')
    cv.rect(462, top - 70, 463, top - 1, '#2a1830')
    cv.rect(456, top - 56, 469, top - 55, '#2a1830')
    save(cv, 'ss_roof.png', parallax=1.0, top=top, beacon=[462, top - 72])


def friends():
    """Plain city pigeons from the product mascot: satchel removed, feathers varied."""
    sheet = Image.open(os.path.join(OUT, 'pigeon-sheet-1x.png')).convert('RGBA')
    cw, ch = 50, 40
    idle = [sheet.crop((c * cw, 0, c * cw + cw, ch)) for c in range(4)]
    variants = [
        (1.0, 0.0, 0.0),  # classic gray
        (0.82, 0.02, 0.0),  # darker
        (1.12, -0.02, 0.0),  # pale
        (0.95, 0.0, 0.05),  # warm check
    ]
    out = Image.new('RGBA', (cw * 4, ch * len(variants)))
    for vi, (bright, blue, warm) in enumerate(variants):
        for fi, cell in enumerate(idle):
            a = np.array(cell).astype(np.float32)
            rgb = a[..., :3]
            r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
            lum = r * 0.3 + g * 0.59 + b * 0.11
            # satchel + strap: darker, warm, saturated-ish browns (not the peach beak/feet)
            brown = (a[..., 3] > 0) & (r - b > 22) & (r < 185) & (lum > 40)
            gray = np.stack([lum * 1.02, lum * 1.03, lum * 1.12], -1)
            rgb[brown] = gray[brown] * 1.25
            body = (a[..., 3] > 0) & ~((r > 190) & (r - b > 50))
            rgb[body] = rgb[body] * bright + np.array([-6 * warm * 0, 0, 30 * blue])[None, :] + np.array([18 * warm, 8 * warm, 0])[None, :]
            a[..., :3] = np.clip(rgb, 0, 255)
            out.alpha_composite(Image.fromarray(a.astype(np.uint8)), (fi * cw, vi * ch))
    save(out, 'pigeon-friends-1x.png', cw=cw, ch=ch, n=len(variants))


if __name__ == '__main__':
    sky()
    city()
    rooftop()
    friends()
    json.dump(manifest, open(MAN, 'w'), indent=1)
    print('ok')
