"""Small pixel-art toolkit shared by the art generators.

Everything is drawn at 1x "art" resolution with hard edges; Remotion upscales the
PNGs with `image-rendering: pixelated`.
"""
from __future__ import annotations

import math
import random
from typing import Iterable

import numpy as np
from PIL import Image, ImageDraw


def hexc(h: str, a: int = 255) -> tuple[int, int, int, int]:
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def mix(c1, c2, t: float):
    c1 = hexc(c1) if isinstance(c1, str) else c1
    c2 = hexc(c2) if isinstance(c2, str) else c2
    return tuple(int(round(c1[i] + (c2[i] - c1[i]) * t)) for i in range(4))


class Mask:
    """Boolean mask helpers built on PIL ImageDraw (no anti-aliasing)."""

    def __init__(self, w: int, h: int):
        self.w, self.h = w, h
        self.img = Image.new('1', (w, h), 0)
        self.d = ImageDraw.Draw(self.img)

    def ellipse(self, cx, cy, rx, ry):
        self.d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=1)
        return self

    def poly(self, pts):
        self.d.polygon([tuple(p) for p in pts], fill=1)
        return self

    def rect(self, x0, y0, x1, y1):
        self.d.rectangle([x0, y0, x1, y1], fill=1)
        return self

    def line(self, pts, width=1):
        self.d.line([tuple(p) for p in pts], fill=1, width=width)
        return self

    def arr(self) -> np.ndarray:
        return np.array(self.img, dtype=bool)


def shift(m: np.ndarray, dx: int, dy: int) -> np.ndarray:
    out = np.zeros_like(m)
    h, w = m.shape
    xs0, xs1 = max(0, -dx), min(w, w - dx)
    ys0, ys1 = max(0, -dy), min(h, h - dy)
    out[ys0 + dy:ys1 + dy, xs0 + dx:xs1 + dx] = m[ys0:ys1, xs0:xs1]
    return out


def dilate(m: np.ndarray, diag: bool = False) -> np.ndarray:
    out = m | shift(m, 1, 0) | shift(m, -1, 0) | shift(m, 0, 1) | shift(m, 0, -1)
    if diag:
        out |= shift(m, 1, 1) | shift(m, -1, -1) | shift(m, 1, -1) | shift(m, -1, 1)
    return out


class Canvas:
    def __init__(self, w: int, h: int, bg=(0, 0, 0, 0)):
        self.w, self.h = w, h
        self.a = np.zeros((h, w, 4), dtype=np.uint8)
        self.a[:] = bg

    def fill(self, m: np.ndarray, color):
        c = hexc(color) if isinstance(color, str) else color
        if c[3] == 255:
            self.a[m] = c
        else:
            a = c[3] / 255
            sel = self.a[m].astype(np.float32)
            sel[:, :3] = sel[:, :3] * (1 - a) + np.array(c[:3]) * a
            sel[:, 3] = np.maximum(sel[:, 3], c[3])
            self.a[m] = sel.astype(np.uint8)

    def px(self, x, y, color):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.a[int(y), int(x)] = hexc(color) if isinstance(color, str) else color

    def rect(self, x0, y0, x1, y1, color):
        x0, x1 = max(0, int(x0)), min(self.w, int(x1) + 1)
        y0, y1 = max(0, int(y0)), min(self.h, int(y1) + 1)
        if x0 >= x1 or y0 >= y1:
            return
        m = np.zeros((self.h, self.w), bool)
        m[y0:y1, x0:x1] = True
        self.fill(m, color)

    def paste(self, other: 'Canvas', x: int, y: int):
        img = self.image()
        img.alpha_composite(other.image(), (int(x), int(y)))
        self.a = np.array(img)

    def image(self) -> Image.Image:
        return Image.fromarray(self.a, 'RGBA')

    def save(self, path: str):
        self.image().save(path)

    def alpha_mask(self) -> np.ndarray:
        return self.a[..., 3] > 0


def shade(canvas: Canvas, m: np.ndarray, base, light, dark, rim_light=True, rim_dark=True,
          band_light: float = 0.0, band_dark: float = 1.0):
    """Fill a part with base colour, lit rim on top-left and shadow on bottom-right.

    band_light/band_dark are fractional y positions within the part's bbox above/below
    which the whole band gets light/dark (for soft cel shading).
    """
    canvas.fill(m, base)
    ys, xs = np.nonzero(m)
    if len(ys) == 0:
        return
    y0, y1 = ys.min(), ys.max()
    hgt = max(1, y1 - y0)
    yy = np.arange(canvas.h)[:, None].repeat(canvas.w, 1)
    rel = (yy - y0) / hgt
    if band_light > 0:
        canvas.fill(m & (rel < band_light), light)
    if band_dark < 1:
        canvas.fill(m & (rel > band_dark), dark)
    if rim_light:
        top = m & ~shift(m, 0, 1)
        canvas.fill(top, light)
    if rim_dark:
        bot = m & ~shift(m, 0, -1)
        canvas.fill(bot, dark)


def outline(canvas: Canvas, m: np.ndarray, color, diag=False):
    ring = dilate(m, diag) & ~m
    canvas.fill(ring, color)


def seeded(seed: int) -> random.Random:
    return random.Random(seed)


def lerp(a, b, t):
    return a + (b - a) * t


def rot(pts: Iterable, cx: float, cy: float, deg: float):
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    return [(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c) for x, y in pts]
