"""Original score and sound design for the PigeonBox launch film.

Everything is synthesized here (no samples, no licensing) and locked to
src/timeline.json's tempo map, so every beat lands on a whole frame:
  90 BPM (20 f/beat)  calm open        frames    0 – 560
  150 BPM (12 f/beat) the chase         frames  560 – 1952
  90 BPM (20 f/beat)  home again        frames 1952 – end

Outputs (public/audio): score.wav plus one file per sound effect / ambience bed.
Also writes src/typing.json so the on-screen typing matches the key clicks.
"""
from __future__ import annotations

import json
import math
import os
import random

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'audio')
os.makedirs(OUT, exist_ok=True)
TL = json.load(open(os.path.join(ROOT, 'src', 'timeline.json')))
SR = 48000
FPS = TL['fps']
EV = TL['events']
SH = TL['shots']
rng = np.random.default_rng(7)

A0, B0, C0 = (seg['from'] for seg in TL['tempo'])


def fa(bar, beat=0.0):
    """Frame of a bar/beat in the slow opening (90 BPM)."""
    return A0 + (bar * 4 + beat) * 20


def fb(bar, beat=0.0):
    """Frame of a bar/beat in the chase (150 BPM)."""
    return B0 + (bar * 4 + beat) * 12


def fc(bar, beat=0.0):
    """Frame of a bar/beat in the slow close (90 BPM)."""
    return C0 + (bar * 4 + beat) * 20


def sec(frame):
    return frame / FPS


def mtof(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


def lp(x, hz, order=2):
    return sosfilt(butter(order, min(hz, SR / 2 - 100), 'low', fs=SR, output='sos'), x)


def hp(x, hz, order=2):
    return sosfilt(butter(order, hz, 'high', fs=SR, output='sos'), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, min(hi, SR / 2 - 100)], 'band', fs=SR, output='sos'), x)


class Bus:
    def __init__(self, seconds: float):
        self.n = int(seconds * SR) + SR * 2
        self.keep = int(seconds * SR)
        self.dry = np.zeros((2, self.n))
        self.wet = np.zeros((2, self.n))

    def add(self, sig: np.ndarray, t: float, gain=1.0, pan=0.0, send=0.3):
        i = int(t * SR)
        if i >= self.n or i < 0:
            return
        sig = sig[: self.n - i]
        l = math.cos((pan + 1) * math.pi / 4)
        r = math.sin((pan + 1) * math.pi / 4)
        self.dry[0, i:i + len(sig)] += sig * gain * l
        self.dry[1, i:i + len(sig)] += sig * gain * r
        self.wet[0, i:i + len(sig)] += sig * gain * l * send
        self.wet[1, i:i + len(sig)] += sig * gain * r * send

    def render(self, ir_seconds=3.2, ir_tone=5200, wet_gain=0.55):
        ir = reverb_ir(ir_seconds, ir_tone)
        wet = np.stack([fftconvolve(self.wet[c], ir[c])[: self.n] for c in range(2)])
        return (self.dry + wet * wet_gain)[:, : self.keep]


def reverb_ir(seconds, tone):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = []
    for c in range(2):
        noise = rng.standard_normal(n)
        env = np.exp(-t * 6.9 / seconds)
        dark = lp(noise, tone * 0.35)
        mixv = np.clip(t / seconds * 1.6, 0, 1)
        sig = (lp(noise, tone) * (1 - mixv) + dark * mixv) * env
        sig[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
        ir.append(sig / np.sqrt(np.sum(sig ** 2)) * 0.9)
    return ir


# ------------------------------------------------------------------ instruments
def felt_piano(m, dur, vel=0.6, bright=1.0):
    f = mtof(m)
    tail = min(4.5, dur + 1.6)
    n = int(tail * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    B = 0.00035
    for k in range(1, 11):
        fk = f * k * math.sqrt(1 + B * k * k)
        if fk > 12000:
            break
        amp = (1 / k ** 1.35) * (0.55 + 0.45 * vel) * (bright ** (k - 1))
        decay = (2.8 + 900 / f) / (1 + 0.45 * (k - 1))
        ph = rng.random() * 6.28
        sig += amp * 0.5 * (np.sin(2 * math.pi * fk * t + ph) + np.sin(2 * math.pi * fk * 1.0009 * t + ph + 0.7)) * np.exp(-t / decay)
    rel = np.ones(n)
    ri = int(dur * SR)
    if ri < n:
        rel[ri:] = np.exp(-(t[ri:] - dur) / 0.35)
    atk = np.minimum(1, t / 0.004)
    hammer = lp(rng.standard_normal(n) * np.exp(-t / 0.012), 2500) * 0.05
    out = (sig * atk + hammer) * rel * vel
    return lp(out, 2200 + 2600 * vel * bright)


def pluck(m, vel=0.5, length=1.4):
    f = mtof(m)
    n = int(length * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for k in range(1, 12):
        fk = f * k
        if fk > 14000:
            break
        sig += (1 / k ** 1.1) * np.sin(2 * math.pi * fk * t) * np.exp(-t * (3.5 + 2.2 * k))
    sig *= np.minimum(1, t / 0.002)
    return lp(sig * vel, 5200)


def saw(f, t, n_h=12, det=0.0):
    out = np.zeros_like(t)
    ff = f * 2 ** (det / 12)
    for k in range(1, n_h + 1):
        if ff * k > 9000:
            break
        out += np.sin(2 * math.pi * ff * k * t) / k
    return out


def stacc(m, vel=0.4, dur=0.09):
    """Short bowed-string ostinato note (the chase motor)."""
    f = mtof(m)
    n = int((dur + 0.18) * SR)
    t = np.arange(n) / SR
    sig = saw(f, t, 10, -0.06) + saw(f, t, 10, 0.07)
    env = np.minimum(1, t / 0.006) * np.where(t < dur, 1.0, np.exp(-(t - dur) / 0.05))
    return lp(sig * env, 3200) * vel * 0.4


def brass(ms, dur, vel=0.5):
    """Low brass-like stab with a filter swell."""
    n = int((dur + 0.6) * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for m in ms:
        sig += saw(mtof(m), t, 16, -0.05) + saw(mtof(m), t, 16, 0.05)
    env = np.minimum(1, t / 0.03) * np.where(t < dur, np.exp(-t / (dur * 2)), np.exp(-dur / (dur * 2)) * np.exp(-(t - dur) / 0.2))
    out = np.zeros(n)
    chunk = 1024
    for i in range(0, n, chunk):
        c = 600 + 3000 * math.exp(-i / SR / 0.25)
        seg = lp(sig[max(0, i - 2048):i + chunk], c)[-min(chunk, n - i):]
        out[i:i + len(seg)] = seg
    return np.tanh(out * env * 0.6) * vel / max(1, len(ms) ** 0.5)


def bell(m, vel=0.5, length=3.5):
    f = mtof(m)
    n = int(length * SR)
    t = np.arange(n) / SR
    ratios = [(1, 1.0, 1.4), (2.0, 0.5, 1.0), (2.76, 0.35, 0.7), (5.4, 0.18, 0.35), (8.93, 0.08, 0.2)]
    sig = sum(a * np.sin(2 * math.pi * f * r * t) * np.exp(-t / d) for r, a, d in ratios)
    return sig * np.minimum(1, t / 0.001) * vel


def pad(ms, dur, vel=0.25, attack=1.2, release=2.0, cutoff=1800):
    n = int((dur + release) * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for m in ms:
        f = mtof(m)
        for det in (-0.07, 0.0, 0.08):
            ff = f * 2 ** (det / 12)
            ph = rng.random() * 6.28
            for k in range(1, 9):
                if ff * k > 8000:
                    break
                sig += (1 / k) * np.sin(2 * math.pi * ff * k * t + ph * k) * 0.33
    env = np.minimum(1, t / attack)
    ri = int(dur * SR)
    env[ri:] *= np.exp(-(t[ri:] - dur) / (release / 3))
    sig = lp(sig * env, cutoff) / max(1, len(ms))
    sig *= 1 + 0.12 * np.sin(2 * math.pi * 0.18 * t)
    return sig * vel


def sub_bass(m, dur, vel=0.5, grit=0.0):
    f = mtof(m)
    n = int((dur + 0.3) * SR)
    t = np.arange(n) / SR
    sig = np.sin(2 * math.pi * f * t) + 0.25 * np.sin(4 * math.pi * f * t) + 0.08 * np.sin(6 * math.pi * f * t)
    if grit:
        sig += grit * lp(saw(f, t, 20), 900)
    env = np.minimum(1, t / 0.008) * np.exp(-t / (dur * 1.2 + 0.15))
    ri = int(dur * SR)
    env[ri:] *= np.exp(-(t[ri:] - dur) / 0.05)
    return np.tanh(sig * env * 1.3) * vel


def kick(vel=0.8, punch=1.0):
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    freq = 44 + 90 * punch * np.exp(-t / 0.035)
    ph = 2 * math.pi * np.cumsum(freq) / SR
    sig = np.sin(ph) * np.exp(-t / 0.16)
    click = hp(rng.standard_normal(n), 3000) * np.exp(-t / 0.003) * 0.15
    return np.tanh((sig + click) * 1.5) * vel


def snare(vel=0.5):
    n = int(0.4 * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * math.pi * 190 * t) * np.exp(-t / 0.05) * 0.6
    noise = bp(rng.standard_normal(n), 1500, 9000) * np.exp(-t / 0.11)
    return np.tanh((body + noise) * 1.2) * vel


def tom(m, vel=0.5):
    n = int(0.5 * SR)
    t = np.arange(n) / SR
    f = mtof(m) * (1 + 0.5 * np.exp(-t / 0.03))
    sig = np.sin(2 * math.pi * np.cumsum(f) / SR) * np.exp(-t / 0.18)
    return sig * vel


def hat(vel=0.2, open_=False):
    n = int((0.25 if open_ else 0.06) * SR)
    t = np.arange(n) / SR
    env = np.exp(-t / (0.08 if open_ else 0.015))
    return hp(rng.standard_normal(n), 7000) * env * vel


def shaker(vel=0.2):
    n = int(0.12 * SR)
    t = np.arange(n) / SR
    env = np.minimum(1, t / 0.012) * np.exp(-t / 0.03)
    return bp(rng.standard_normal(n), 5000, 12000) * env * vel


def snap(vel=0.35):
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    burst = np.zeros(n)
    for d in (0.0, 0.009, 0.018):
        i = int(d * SR)
        burst[i:] += np.exp(-(t[: n - i]) / 0.006)
    body = bp(rng.standard_normal(n), 900, 5000) * (burst + 0.4 * np.exp(-t / 0.07))
    return body * vel


def noise_swell(dur, vel=0.4, lo=2000, hi=12000, rise=True):
    n = int(dur * SR)
    t = np.arange(n) / SR
    env = (t / dur) ** 2.2 if rise else np.exp(-t / (dur / 4))
    return bp(rng.standard_normal(n), lo, hi) * env * vel


def riser(dur, vel=0.35):
    n = int(dur * SR)
    t = np.arange(n) / SR
    out = np.zeros(n)
    chunk = 512
    noise = rng.standard_normal(n)
    for i in range(0, n, chunk):
        p = i / n
        c = 300 + 7000 * p ** 2
        seg = bp(noise[max(0, i - 2048):i + chunk], c * 0.7, c * 1.4)[-min(chunk, n - i):]
        out[i:i + len(seg)] = seg
    f = 200 * 2 ** (3 * t / dur)
    tone = np.sin(2 * math.pi * np.cumsum(f) / SR) * 0.15
    return (out + tone) * (t / dur) ** 2 * vel


def boom(vel=0.7, length=3.0):
    n = int(length * SR)
    t = np.arange(n) / SR
    freq = 38 + 40 * np.exp(-t / 0.2)
    sig = np.sin(2 * math.pi * np.cumsum(freq) / SR) * np.exp(-t / 0.9)
    return sig * vel


def hit(bus, frame, vel=1.0, chord=None):
    """Cinematic impact: boom + crash + (optional) brass stab."""
    t = sec(frame)
    bus.add(boom(0.7 * vel), t, 0.9, 0, 0.3)
    bus.add(noise_swell(2.5, 0.28 * vel, 2500, 14000, rise=False), t, 0.6, 0, 0.6)
    bus.add(kick(0.9 * vel, 1.4), t, 0.8, 0, 0.2)
    if chord:
        bus.add(brass(chord, 0.5, 0.55 * vel), t, 0.8, 0, 0.35)


# ----------------------------------------------------------------------- score
CH = {
    'D': [50, 57, 62, 64, 66, 69],
    'Bm': [47, 54, 57, 62, 66, 69],
    'G': [43, 50, 54, 59, 62, 69],
    'A': [45, 52, 57, 61, 64, 69],
    'Asus': [45, 52, 57, 62, 64, 69],
    'Em': [40, 47, 50, 55, 59, 66],
    'Gadd9': [43, 50, 57, 59, 62, 69],
    'Dm': [50, 57, 62, 65, 69, 74],
    'Bb': [46, 53, 58, 62, 65, 70],
    'F': [41, 48, 53, 57, 60, 65],
    'C': [48, 55, 60, 64, 67, 72],
    'Gm': [43, 50, 55, 58, 62, 67],
}
ROOTS = {'D': 38, 'Bm': 35, 'G': 43, 'A': 45, 'Asus': 45, 'Em': 40, 'Gadd9': 43,
         'Dm': 38, 'Bb': 34, 'F': 41, 'C': 36, 'Gm': 43}

THEME = [(0, 69, 1), (1, 74, 1), (2, 78, 1.5), (3.5, 76, 0.5), (4, 74, 1), (5, 71, 1), (6, 69, 2)]
ANSWER = [(0, 69, 1), (1, 74, 1), (2, 78, 1), (3, 81, 1.5), (4.5, 79, 0.5), (5, 78, 1), (6, 76, 1), (7, 74, 1)]
# the chase motif in D minor, 16ths
CHASE = [62, 65, 69, 65, 62, 65, 69, 74]

PROG_A = ['D', 'Bm', 'G', 'Asus', 'D', 'Bm', 'G']
# 32 bars of 150 BPM from frame 560. Calm bars (desk cutaways) are piano only.
PROG_B = ['Dm', 'Bb', 'C',  # 0-2   ledge tail, rooftops
          'Dm', 'Dm', 'Dm', 'Dm',  # 3-6   desk: sorted (calm)
          'Dm', 'Bb', 'A',  # 7-9   street
          'Dm', 'Dm', 'Dm',  # 10-12 desk: thread + draft (calm)
          'Bb', 'Gm', 'Dm', 'A',  # 13-16 airliner (pass on 15)
          'Dm', 'Dm',  # 17-18 desk: ask (calm)
          'Dm', 'Bb', 'Gm', 'A',  # 19-22 hawk (strike 21, second pass 22)
          'Dm', 'Dm',  # 23-24 desk: waiting (calm)
          'Dm', 'Bb', 'Gm', 'A',  # 25-28 storm (lightning 26, 27, 28)
          'D', 'G', 'Asus']  # 29-31 breakthrough
CALM_PROG = ['D', 'Bm', 'G', 'A']  # the opening's chords, back on the desk
PROG_C = ['Bm', 'G', 'Gadd9', 'Em', 'Gadd9', 'Asus', 'D', 'Bm', 'G', 'A', 'D', 'G', 'Asus', 'D', 'D']


def phrase(bus, notes, start_frame, fpb, inst='piano', vel=0.5, transpose=0, pan=0.15, send=0.45, stretch=1.0):
    spb = fpb / FPS
    for off, m, dur in notes:
        t = sec(start_frame + off * fpb * stretch)
        d = dur * spb * stretch
        if inst == 'piano':
            bus.add(felt_piano(m + transpose, d, vel), t, 0.55, pan, send)
        elif inst == 'pluck':
            bus.add(pluck(m + transpose, vel, 1.0 + d), t, 0.5, pan, send)
        elif inst == 'bell':
            bus.add(bell(m + transpose, vel), t, 0.25, pan, send + 0.2)


def section_a(bus):
    spb = 20 / FPS
    for b, name in enumerate(PROG_A):
        ch = CH[name]
        t0 = sec(fa(b))
        bus.add(pad(ch[1:5], 4 * spb, 0.16 * (0.7 if b == 0 else 1), attack=1.5 if b == 0 else 0.6, cutoff=1400), t0, 1.0, 0, 0.6)
        step = 1.0 if b < 2 else 0.5
        pattern = [0, 2, 3, 4, 5, 4, 3, 2]
        for i, bt in enumerate(np.arange(0, 4, step)):
            m = ch[pattern[i % len(pattern)]] + 12
            bus.add(felt_piano(m, step * spb * 1.8, 0.32 + 0.1 * (i % 2 == 0)), t0 + bt * spb, 0.5, -0.25 + 0.1 * (i % 3), 0.5)
    phrase(bus, THEME, fa(3), 20, 'piano', 0.42, 12, 0.1, 0.55)
    phrase(bus, ANSWER, fa(5), 20, 'piano', 0.38, 12, 0.1, 0.55)
    # riser into the chase
    bus.add(riser(sec(B0 - fa(6, 1))), sec(fa(6, 1)), 0.55, 0, 0.4)
    bus.add(noise_swell(sec(B0 - fa(6, 2)), 0.25), sec(fa(6, 2)), 0.5, 0, 0.5)


def calm_mask(n_samples):
    """1 where the chase is on screen, 0 during desk cutaways (sharp 12 ms edges)."""
    m = np.ones(n_samples)
    ramp = int(0.012 * SR)
    for f0, f1 in TL['calm']:
        i0, i1 = int(sec(f0) * SR), int(sec(f1) * SR)
        m[i0:i1] = 0
        m[i0 - ramp:i0] = np.linspace(1, 0, ramp)
        m[i1:i1 + ramp] = np.linspace(0, 1, ramp)
    return m


def is_calm_bar(b):
    f = fb(b)
    return any(f0 <= f < f1 for f0, f1 in TL['calm'])


def section_b(bus, calm):
    """The chase on `bus`; the desk cutaways' quiet piano on `calm`."""
    spb = 12 / FPS
    s16 = spb / 4
    ci_calm = 0
    for b, name in enumerate(PROG_B):
        ch = CH[name]
        t0 = sec(fb(b))
        burst = b >= 29
        storm = 25 <= b <= 28
        hawk = 19 <= b <= 22
        jet_build = b in (13, 14)
        if is_calm_bar(b):
            # the room: just a piano, pedal down, the opening's chords
            cc = CH[CALM_PROG[ci_calm % 4]]
            ci_calm += 1
            calm.add(felt_piano(cc[0] - 12 if cc[0] > 45 else cc[0], 4 * spb * 1.3, 0.24, bright=0.7), t0, 0.5, -0.1, 0.5)
            for i, k in enumerate([1, 3, 4, 3]):
                calm.add(felt_piano(cc[k] + 12, spb * 3.5, 0.2 + 0.04 * (i == 0), bright=0.85), t0 + i * spb, 0.5, -0.2 + 0.13 * i, 0.55)
        # pads
        bus.add(pad(ch[1:5], 4 * spb, 0.2 if not burst else 0.32, attack=0.2, release=1.2,
                    cutoff=2600 if burst else 1500), t0, 1.0, 0, 0.55)
        if burst:
            bus.add(kick(0.8), t0, 0.8, 0, 0.1)
            bus.add(snare(0.45), t0 + 2 * spb, 0.7, 0, 0.5)
            for i in range(8):
                m = ch[[1, 3, 4, 5, 4, 3, 5, 4][i]] + 12
                bus.add(pluck(m, 0.3), t0 + i * 0.5 * spb, 0.45, 0.35 - 0.1 * (i % 2), 0.5)
            if b < 31:
                bus.add(sub_bass(ROOTS[name], 3.6 * spb, 0.4), t0, 0.8, 0, 0.05)
            continue
        steps = 16 if storm else 8
        for i in range(steps):
            m = ROOTS[name] + (12 if i % 4 == 3 else 0)
            bus.add(sub_bass(m, 0.8 * 4 * spb / steps, 0.36, grit=0.25), t0 + i * 4 * spb / steps, 0.8, 0, 0.03)
        kicks = [0, 1.5, 2, 2.75] if not storm else [0, 0.75, 1.5, 2, 2.5, 3.25]
        for k in kicks:
            bus.add(kick(0.72), t0 + k * spb, 0.8, 0, 0.05)
        for k in (1, 3):
            bus.add(snare(0.42), t0 + k * spb, 0.7, 0.05, 0.3)
        for i in range(16):
            bus.add(hat(0.1 if i % 2 else 0.06, open_=(i == 14)), t0 + i * s16, 0.7, 0.35, 0.1)
        if not is_calm_bar(b) and (b % 4 == 3 or b in (16, 22, 28) or is_calm_bar(b + 1)):
            for i in range(8):
                bus.add(tom([45, 43, 41, 40, 38, 36, 35, 33][i] + 12, 0.45), t0 + 2 * spb + i * s16, 0.7, -0.4 + i * 0.1, 0.3)
        src = [ch[1] + 12, ch[3], ch[4], ch[3]] if not (hawk or storm) else [ch[2], ch[3], ch[4], ch[5], ch[4], ch[3], ch[2], ch[3]]
        for i in range(16):
            m = src[i % len(src)] + (12 if (storm and i % 8 == 7) else 0)
            vel = 0.36 if i % 4 == 0 else 0.26
            if jet_build:
                vel *= 0.8 + 0.4 * (b - 13 + i / 16)
            bus.add(stacc(m, vel), t0 + i * s16, 0.7, -0.3 + 0.6 * (i % 2), 0.25)
        if b in (1, 2, 7, 8, 19, 20):
            for i, m in enumerate(CHASE):
                bus.add(pluck(m + 12, 0.28, 0.5), t0 + (8 + i) * s16, 0.5, 0.25, 0.35)
    # the sender's theme on the desk, half-time
    for f0, f1 in TL['calm']:
        phrase(calm, THEME[:4], f0 + 6, 12, 'piano', 0.26, 12, 0.15, 0.6, stretch=2)
    phrase(bus, THEME, fb(29), 12, 'piano', 0.5, 24, 0.0, 0.6, stretch=1.5)
    phrase(bus, THEME, fb(29), 12, 'bell', 0.35, 12, 0.3, 0.6, stretch=1.5)

    # impacts: the takeoff drop, every slam back into the chase, and each hazard
    hit(bus, B0, 1.0, CH['Dm'][:3])
    for f0, f1 in TL['calm']:
        hit(bus, f1, 0.75, CH['Dm'][:3])
    bus.add(riser(sec(EV['jetPass'] - fb(13))), sec(fb(13)), 0.5, 0, 0.4)
    hit(bus, EV['jetPass'], 1.2, [38, 45, 50])
    bus.add(riser(sec(EV['hawkStrike'] - fb(19))), sec(fb(19)), 0.45, 0, 0.4)
    hit(bus, EV['hawkStrike'], 1.1, [43, 50, 55])
    hit(bus, EV['hawkSecond'], 0.8, [45, 52, 57])
    for k in ('lightning1', 'lightning2', 'lightning3'):
        hit(bus, EV[k], 1.0 if k != 'lightning3' else 1.3, [38, 45, 50] if k != 'lightning2' else [34, 41, 46])
    bus.add(riser(sec(EV['breakthrough'] - fb(28))), sec(fb(28)), 0.55, 0, 0.4)
    bus.add(noise_swell(sec(EV['breakthrough'] - fb(28, 2)), 0.3), sec(fb(28, 2)), 0.6, 0, 0.5)
    hit(bus, EV['breakthrough'], 1.1)
    for i, m in enumerate([74, 78, 81, 86]):
        bus.add(bell(m, 0.4), sec(EV['breakthrough']) + i * 0.06, 0.25, -0.3 + i * 0.2, 0.7)
    bus.add(noise_swell(sec(C0 - fb(31)), 0.12), sec(fb(31)), 0.5, 0, 0.7)


def section_c(bus):
    spb = 20 / FPS
    for b, name in enumerate(PROG_C):
        ch = CH[name]
        t0 = sec(fc(b))
        pv = 0.17 if b < 13 else 0.2
        bus.add(pad(ch[1:5], 4 * spb, pv, attack=1.4 if b == 0 else 0.6, cutoff=2000), t0, 1.0, 0, 0.6)
        suspense = 4 <= b <= 5
        groove = 7 <= b <= 9
        step = 1.0 if suspense or b in (0, 1) else 0.5
        pattern = [0, 2, 3, 4, 5, 4, 3, 2]
        for i, bt in enumerate(np.arange(0, 4, step)):
            if b >= 14 and bt > 0:
                break
            m = ch[pattern[i % len(pattern)]] + 12
            bus.add(felt_piano(m, step * spb * 1.8, 0.3 + 0.08 * (i % 2 == 0)), t0 + bt * spb, 0.5, -0.25 + 0.1 * (i % 3), 0.5)
        if b in (0, 1):
            # descent: plucks carried over from the chase, fading
            for i in range(8):
                m = ch[[1, 3, 4, 5, 4, 3, 5, 4][i]] + 12
                if i % 2 == 0:
                    bus.add(pluck(m, 0.16 * (1 - b * 0.4)), t0 + i * 0.5 * spb, 0.45, 0.35 - 0.1 * (i % 2), 0.55)
            bus.add(felt_piano(ROOTS[name] + 12, 3.8 * spb, 0.3, bright=0.6), t0, 0.5, 0, 0.4)
        if suspense:
            for k in range(4):
                bus.add(pluck(ch[4] + 24, 0.07, 0.6), t0 + k * spb, 0.4, 0.5, 0.6)
        if groove:
            bus.add(felt_piano(ROOTS[name] + 12, 3.8 * spb, 0.3, bright=0.6), t0, 0.5, 0, 0.4)
    phrase(bus, THEME[:3], fc(3), 20, 'piano', 0.3, 12, 0.2, 0.7)
    # opened
    for i, m in enumerate([74, 78, 81, 86, 90]):
        bus.add(bell(m, 0.5), sec(EV['opened']) + i * 0.07, 0.3, -0.3 + i * 0.15, 0.7)
    bus.add(noise_swell(sec(EV['opened'] - fc(5, 2)), 0.12), sec(fc(5, 2)), 0.5, 0, 0.6)
    phrase(bus, THEME, fc(8), 20, 'piano', 0.4, 12, 0.1, 0.5)
    phrase(bus, ANSWER, fc(10), 20, 'piano', 0.38, 12, 0.1, 0.5)
    # final chord at the logo
    t = sec(EV['logo'])
    for m in (62, 66, 69, 74, 78):
        bus.add(felt_piano(m, 5.0, 0.45), t, 0.45, (m - 70) / 20, 0.6)
    bus.add(felt_piano(38, 5.0, 0.5), t, 0.5, 0, 0.4)
    bus.add(bell(86, 0.35), t + 0.02, 0.25, 0.3, 0.8)


def score():
    total_s = TL['total'] / FPS + 3
    main = Bus(total_s)
    chase = Bus(total_s)
    calm = Bus(total_s)
    section_a(main)
    section_b(chase, calm)
    section_c(main)
    chase_mix = chase.render(3.0, 5000, 0.45)
    # the desk cutaways are the room only: the chase drops out entirely
    m = calm_mask(chase_mix.shape[1])
    mix = main.render(3.0, 5000, 0.45) + chase_mix * m + calm.render(2.8, 4200, 0.55)
    mix = master(mix, TL['total'] / FPS)
    wavfile.write(os.path.join(OUT, 'score.wav'), SR, (mix.T * 32767).astype(np.int16))


def master(mix, seconds, peak=0.8, fade_out=3.0):
    n = int(seconds * SR)
    mix = mix[:, :n]
    mix = np.tanh(mix * 1.1) / 1.1
    t = np.arange(n) / SR
    fo = np.clip((seconds - t) / fade_out, 0, 1)
    fi = np.clip(t / 0.05, 0, 1)
    mix *= fo * fi
    return mix / (np.max(np.abs(mix)) + 1e-9) * peak


def write(name, sig, peak=0.8):
    if sig.ndim == 1:
        sig = np.stack([sig, sig])
    sig = sig / (np.max(np.abs(sig)) + 1e-9) * peak
    wavfile.write(os.path.join(OUT, name), SR, (sig.T * 32767).astype(np.int16))


# ------------------------------------------------------------------ sound design
def birds(seconds, density=0.6, seed=1):
    r = random.Random(seed)
    bus = Bus(seconds)
    t = 0.3
    while t < seconds - 1:
        base = r.uniform(2800, 5200)
        pan = r.uniform(-0.8, 0.8)
        for k in range(r.randint(2, 6)):
            d = r.uniform(0.04, 0.12)
            n = int(d * SR)
            tt = np.arange(n) / SR
            f = base * (1 + r.uniform(-0.25, 0.35) * np.sin(math.pi * tt / d)) * (1 + 0.04 * np.sin(2 * math.pi * 40 * tt))
            ch = np.sin(2 * math.pi * np.cumsum(f) / SR) * np.sin(math.pi * tt / d) ** 2
            bus.add(ch * r.uniform(0.15, 0.4), t + k * r.uniform(0.09, 0.16), 1.0, pan, 0.5)
        t += r.expovariate(density) + 0.4
    return bus.render(1.4, 6000, 0.4)


def brown(n, cutoff=300):
    w = np.cumsum(rng.standard_normal(n))
    w = hp(w, 20)
    return lp(w / (np.max(np.abs(w)) + 1e-9), cutoff)


def env_edges(out, s, fin=0.4, fout=0.8):
    t = np.arange(out.shape[-1]) / SR
    return out * np.clip(t / fin, 0, 1) * np.clip((s - t) / fout, 0, 1)


def amb_morning():
    s = SH['ledge'][1] / FPS + 1
    n = int(s * SR)
    room = brown(n, 180) * 0.25 + lp(rng.standard_normal(n), 900) * 0.01
    out = np.stack([room, room]) + birds(s, 0.5, 3)[:, :n] * 0.7
    write('amb_morning.wav', out, 0.5)


def amb_city():
    s = (SH['street'][1] - SH['street'][0]) / FPS + 1
    n = int(s * SR)
    bus = Bus(s)
    bus.add(brown(n, 350) * 0.6, 0, 1.0, 0, 0.1)
    murmur = bp(rng.standard_normal(n), 250, 2500) * (0.5 + 0.5 * lp(np.abs(rng.standard_normal(n)), 3)) * 0.08
    bus.add(murmur, 0, 1.0, 0.2, 0.3)
    r = random.Random(9)
    for k in range(6):
        tc = r.uniform(0, s - 2)
        d = r.uniform(1.2, 2.0)
        m = int(d * SR)
        tt = np.arange(m) / SR
        env = np.exp(-((tt - d / 2) / (d / 5)) ** 2)
        bus.add(bp(rng.standard_normal(m), 120, 1800) * env * 0.5, tc, 1.0, r.uniform(-0.9, 0.9), 0.15)
    m = int(0.32 * SR)
    tt = np.arange(m) / SR
    horn = (np.sign(np.sin(2 * math.pi * 392 * tt)) + np.sign(np.sin(2 * math.pi * 494 * tt))) * 0.5
    bus.add(lp(horn, 1600) * np.minimum(1, tt / 0.02) * np.exp(-tt / 0.25) * 0.12, 3.4, 1.0, 0.6, 0.8)
    tb = (EV['tramBell'] - SH['street'][0]) / FPS
    m = int(4 * SR)
    tt = np.arange(m) / SR
    bus.add(lp(rng.standard_normal(m), 160) * np.exp(-((tt - 1.6) / 1.1) ** 2) * 1.2, tb - 1.2, 1.0, -0.2, 0.1)
    for dt in (0.0, 0.22):
        bus.add(bell(88, 0.3, 1.8) + bell(83, 0.2, 1.8), tb + dt, 0.6, 0.3, 0.5)
    write('amb_city.wav', env_edges(bus.render(1.8, 4500, 0.35), s, 0.2, 0.4), 0.55)


def amb_park():
    s = (SH['hawk'][1] - SH['hawk'][0]) / FPS + 1
    n = int(s * SR)
    water = bp(rng.standard_normal(n), 400, 5000) * (0.6 + 0.4 * lp(np.abs(rng.standard_normal(n)), 6)) * 0.12
    bus = Bus(s)
    bus.add(water, 0, 1.0, -0.3, 0.3)
    out = bus.render(1.5, 5000, 0.4) + birds(s, 1.2, 21)[:, :n] * 0.9
    write('amb_park.wav', env_edges(out, s, 0.2, 0.4), 0.5)


def wind(seconds, name, level=0.5, gusty=False):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros((2, n))
    for c in range(2):
        mod = 0.55 + 0.45 * np.sin(2 * math.pi * (0.13 + 0.05 * c) * t + c) * np.sin(2 * math.pi * 0.071 * t)
        if gusty:
            mod = mod * (0.6 + 0.8 * np.abs(np.sin(2 * math.pi * 0.45 * t + c)))
        out[c] = bp(rng.standard_normal(n), 250, 1600 if not gusty else 2600) * mod
    write(name, env_edges(out, seconds, 0.5, 0.8), level)


def amb_residential():
    s = (SH['inbox'][0] - SH['descent'][0]) / FPS + 1
    n = int(s * SR)
    base = brown(n, 220) * 0.2
    out = np.stack([base, base]) + birds(s, 0.7, 31)[:, :n] * 0.8
    write('amb_residential.wav', env_edges(out, s, 0.6, 0.6), 0.45)


def storm_bed():
    s = (SH['storm'][1] - SH['storm'][0]) / FPS + 1.5
    n = int(s * SR)
    bus = Bus(s)
    rain = hp(rng.standard_normal(n), 1500) * 0.35 + bp(rng.standard_normal(n), 300, 1200) * 0.25
    bus.add(rain, 0, 1.0, -0.2, 0.2)
    bus.add(hp(rng.standard_normal(n), 1800) * 0.3, 0, 1.0, 0.3, 0.2)
    r = random.Random(4)
    for k in range(900):  # individual drops
        m = int(0.02 * SR)
        tt = np.arange(m) / SR
        f = r.uniform(2000, 6000)
        bus.add(np.sin(2 * math.pi * f * tt) * np.exp(-tt / 0.003) * 0.15, r.uniform(0, s - 0.1), 1.0, r.uniform(-1, 1), 0.3)
    wind_n = bp(rng.standard_normal(n), 200, 1200) * (0.5 + 0.5 * np.abs(np.sin(2 * math.pi * 0.35 * np.arange(n) / SR))) * 0.6
    bus.add(wind_n, 0, 1.0, 0, 0.2)
    write('storm_bed.wav', env_edges(bus.render(1.2, 4000, 0.3), s, 0.25, 0.9), 0.6)


def thunder(name, seed):
    r = random.Random(seed)
    s = 4.5
    n = int(s * SR)
    t = np.arange(n) / SR
    crack = hp(rng.standard_normal(n), 1200) * np.exp(-t / 0.05) * 1.2
    bumps = np.zeros(n)
    for k in range(10):
        c = r.uniform(0.1, 2.2)
        bumps += np.exp(-((t - c) / r.uniform(0.08, 0.35)) ** 2) * r.uniform(0.4, 1.0)
    rumble = lp(rng.standard_normal(n), 140) * (bumps + 0.3) * np.exp(-t / 1.6) * 3
    out = np.stack([crack + rumble, np.roll(crack, 40) + rumble])
    write(name, out, 0.85)


def jet():
    """Airliner passing inches overhead: rumble + whine with doppler, left to right."""
    s = 5.0
    n = int(s * SR)
    t = np.arange(n) / SR
    peak = 2.0  # seconds into the file: the pass
    prox = 1 / (1 + ((t - peak) / 0.55) ** 2)
    rumble = brown(n, 500) * 1.2 + bp(rng.standard_normal(n), 80, 900) * 0.8
    dop = 1 + 0.12 * np.tanh((peak - t) / 0.35)
    whine = np.sin(2 * math.pi * np.cumsum(1900 * dop) / SR) * 0.10 + np.sin(2 * math.pi * np.cumsum(3100 * dop) / SR) * 0.05
    hiss = bp(rng.standard_normal(n), 2000, 9000) * 0.35
    sig = (rumble + whine + hiss) * prox
    pan = np.tanh((t - peak) / 0.5)
    l = np.cos((pan + 1) * math.pi / 4)
    r = np.sin((pan + 1) * math.pi / 4)
    out = np.stack([sig * l, sig * r])
    write('jet.wav', env_edges(out, s, 0.3, 1.0), 0.95)


def screech():
    """Red-tailed hawk: a hoarse, descending 'kee-eeeer'."""
    s = 1.3
    n = int(s * SR)
    t = np.arange(n) / SR
    f = 2600 - 900 * (t / s) ** 0.7
    f = f * (1 + 0.02 * np.sin(2 * math.pi * 35 * t))
    ph = 2 * math.pi * np.cumsum(f) / SR
    tone = np.sin(ph) + 0.5 * np.sin(2 * ph) + 0.25 * np.sin(3 * ph)
    rasp = bp(rng.standard_normal(n), 1500, 5000) * 0.6
    amp = np.interp(t / s, [0, 0.05, 0.2, 0.7, 1], [0, 1, 0.8, 0.6, 0])
    bus = Bus(s + 1)
    bus.add(lp((tone * (1 + 0.5 * np.sin(2 * math.pi * 70 * t)) + rasp) * amp, 6000), 0, 1.0, 0.3, 0.5)
    write('screech.wav', bus.render(1.4, 6000, 0.5), 0.7)


def wing_flap(vel=1.0):
    n = int(0.11 * SR)
    t = np.arange(n) / SR
    env = np.minimum(1, t / 0.015) * np.exp(-t / 0.035)
    whoosh = bp(rng.standard_normal(n), 300, 2400) * env
    thump = np.sin(2 * math.pi * 110 * t) * np.exp(-t / 0.02) * 0.4
    return (whoosh + thump) * vel


def flap_period(f):
    fl = TL['flap']
    return fl['fast'] if fl['fastFrom'] <= f < fl['fastTo'] else fl['slow']


def flight_flaps():
    """Flaps locked to the sprite: fast in the chase, slow when calm, none while gliding."""
    start, end = EV['takeoff'], EV['landing']
    s = (end - start) / FPS + 1
    bus = Bus(s)
    f = start
    k = 0
    while f < end:
        at_desk = any(f0 <= f < f1 for f0, f1 in TL['calm'])
        if not (EV['glideStart'] <= f < EV['glideEnd']) and not at_desk:
            vel = 0.5 if flap_period(f) == TL['flap']['fast'] else 0.42
            bus.add(wing_flap(vel), (f - start) / FPS, 1.0, 0.1 * math.sin(k), 0.15)
        f += flap_period(f)
        k += 1
    write('flight_flaps.wav', bus.render(0.8, 4000, 0.2), 0.6)


def whoosh(dur=0.9, name='whoosh.wav', lo=200, hi=5000, peak=0.6):
    n = int(dur * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    chunk = 256
    for i in range(0, n, chunk):
        p = i / n
        c = lo + (hi - lo) * math.sin(math.pi * p) ** 1.5
        seg = bp(noise[max(0, i - 2048):i + chunk], max(60, c * 0.6), c * 1.5)[-min(chunk, n - i):]
        out[i:i + len(seg)] = seg
    env = np.sin(math.pi * np.clip(t / dur, 0, 1)) ** 2
    write(name, np.stack([out * env, np.roll(out, 90) * env]), peak)


def typing():
    text = "Hi Maya,\n\nHere's the new direction, with both changes. Can't wait to hear what you think."
    r = random.Random(42)
    frames = []
    f = float(EV['typingStart'])
    for ch in text:
        frames.append(round(f))
        if ch in ',.':
            f += r.uniform(5, 8)
        elif ch == '\n':
            f += r.uniform(3, 6)
        elif ch == ' ':
            f += r.uniform(1.6, 2.6)
        else:
            f += r.uniform(1.2, 2.2)
    json.dump({'text': text, 'frames': frames}, open(os.path.join(ROOT, 'src', 'typing.json'), 'w'))
    start = SH['compose'][0]
    s = (frames[-1] - start) / FPS + 2
    bus = Bus(s)
    for ch, fr in zip(text, frames):
        n = int(0.06 * SR)
        t = np.arange(n) / SR
        big = ch in ' \n'
        f0 = r.uniform(2400, 4200) * (0.6 if big else 1)
        click = bp(rng.standard_normal(n), f0 * 0.7, f0 * 1.5) * np.exp(-t / 0.006)
        thock = np.sin(2 * math.pi * (140 if big else r.uniform(180, 260)) * t) * np.exp(-t / 0.015) * 0.6
        bus.add((click * 0.8 + thock) * r.uniform(0.6, 1.0), (fr - start) / FPS, 1.0, r.uniform(-0.2, 0.2), 0.12)
    write('typing.wav', bus.render(0.5, 6000, 0.25), 0.5)
    n = int(0.2 * SR)
    t = np.arange(n) / SR
    c = np.zeros(n)
    for d, a in ((0, 1.0), (0.07, 0.6)):
        i = int(d * SR)
        c[i:] += bp(rng.standard_normal(n - i), 2000, 8000) * np.exp(-t[: n - i] / 0.003) * a
        c[i:] += np.sin(2 * math.pi * 900 * t[: n - i]) * np.exp(-t[: n - i] / 0.004) * a * 0.3
    write('click.wav', c, 0.5)


def sparkle():
    bus = Bus(3)
    r = random.Random(3)
    for i, m in enumerate([86, 90, 93, 98, 95, 102, 98]):
        bus.add(bell(m, 0.3, 1.5), i * 0.075 + r.uniform(0, 0.02), 1.0, r.uniform(-0.6, 0.6), 0.8)
    write('sparkle.wav', bus.render(2.0, 7000, 0.6), 0.5)


def takeoff():
    bus = Bus(2.5)
    for k in range(6):
        bus.add(wing_flap(1.0 - k * 0.1), k * 0.085, 1.0, 0.2 * (k % 2 * 2 - 1), 0.2)
    n = int(1.2 * SR)
    t = np.arange(n) / SR
    bus.add(bp(rng.standard_normal(n), 400, 3000) * np.exp(-t / 0.35) * np.minimum(1, t / 0.05) * 0.5, 0.05, 1.0, 0.3, 0.3)
    write('takeoff.wav', bus.render(1.0, 4000, 0.3), 0.75)


def coo():
    bus = Bus(3)
    for start, scale in ((0.0, 1.0), (1.05, 0.9)):
        d = 0.85
        n = int(d * SR)
        t = np.arange(n) / SR
        p = t / d
        f = 330 + 90 * np.sin(math.pi * np.clip((p - 0.15) / 0.5, 0, 1)) - 60 * np.clip((p - 0.65) / 0.35, 0, 1)
        f = f * (1 + 0.012 * np.sin(2 * math.pi * 6 * t))
        ph = 2 * math.pi * np.cumsum(f) / SR
        tone = np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.1 * np.sin(3 * ph)
        amp = np.interp(p, [0, 0.08, 0.2, 0.3, 0.55, 0.85, 1], [0, 0.5, 0.35, 0.9, 1.0, 0.4, 0])
        breath = bp(rng.standard_normal(n), 300, 1500) * 0.08
        bus.add(lp((tone + breath) * amp, 900) * scale, start, 1.0, 0.25, 0.35)
    write('coo.wav', bus.render(1.2, 3000, 0.3), 0.55)


def ui_sounds():
    bus = Bus(3)
    bus.add(bell(81, 0.5, 2.0), 0.0, 1.0, 0.1, 0.5)
    bus.add(bell(86, 0.45, 2.4), 0.13, 1.0, 0.1, 0.5)
    write('chime.wav', bus.render(1.5, 6000, 0.4), 0.45)
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    f = 520 * np.exp(-t / 0.06) + 280
    write('pop.wav', np.sin(2 * math.pi * np.cumsum(f) / SR) * np.exp(-t / 0.05), 0.4)
    bus = Bus(2)
    for i, m in enumerate([93, 98]):
        bus.add(bell(m, 0.4, 1.5), i * 0.06, 1.0, 0.3, 0.7)
    write('glint.wav', bus.render(1.4, 8000, 0.5), 0.4)


if __name__ == '__main__':
    typing()
    amb_morning()
    amb_city()
    amb_park()
    wind(5.5, 'wind.wav', 0.45)
    amb_residential()
    storm_bed()
    for i, seed in enumerate((11, 12, 13)):
        thunder(f'thunder{i + 1}.wav', seed)
    jet()
    screech()
    flight_flaps()
    whoosh(0.9, 'whoosh.wav')
    whoosh(0.5, 'whoosh_short.wav', 400, 7000, 0.55)
    whoosh(1.6, 'whoosh_long.wav', 120, 3000, 0.55)
    sparkle()
    takeoff()
    coo()
    ui_sounds()
    score()
    print('ok')
