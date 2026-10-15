"""Sound design for the kinetic launch film: no music, only foley that follows the picture.

Whooshes on cuts, low impacts on the big moments, UI clicks and key ticks for every visible
action. Lay a licensed music track underneath with scripts/mux-kinetic.sh.

    python3 scripts/gen_kinetic_sfx.py   ->  public/kinetic/sfx.wav
"""

import json
import os

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TL = json.load(open(os.path.join(ROOT, "src/kinetic/timeline.json")))
BEAT = 60.0 / TL["bpm"]
FPS = 60
START = {}
_acc = 0.0
for name, beats in TL["shots"]:
    START[name] = _acc
    _acc += beats
LENGTH = int(_acc * BEAT * SR)
rng = np.random.default_rng(11)


def at(beat):
    return int(round(beat * BEAT * SR))


def fr(shot, frames):
    return START[shot] + frames / FPS / BEAT


def bp(x, lo, hi, order=2):
    b, a = signal.butter(order, [lo / (SR / 2), min(hi, SR / 2 - 200) / (SR / 2)], "band")
    return signal.lfilter(b, a, x)


def lp(x, hz, order=2):
    b, a = signal.butter(order, hz / (SR / 2), "low")
    return signal.lfilter(b, a, x)


def hp(x, hz, order=2):
    b, a = signal.butter(order, hz / (SR / 2), "high")
    return signal.lfilter(b, a, x)


L = np.zeros(LENGTH)
R = np.zeros(LENGTH)


def add(x, beat, gain=1.0, pan=0.0):
    i = at(beat)
    n = min(len(x), LENGTH - i)
    if n <= 0 or i < 0:
        return
    L[i:i + n] += x[:n] * gain * np.cos((pan + 1) * np.pi / 4) * np.sqrt(2)
    R[i:i + n] += x[:n] * gain * np.sin((pan + 1) * np.pi / 4) * np.sqrt(2)


def sweep_noise(dur, lo, hi, shape):
    n = int(dur * SR)
    noise = rng.standard_normal(n)
    out = np.zeros(n)
    seg = 256
    zi = None
    for s0 in range(0, n, seg):
        p = s0 / n
        c = lo * (hi / lo) ** shape(p)
        b, a = signal.butter(2, [max(60, c * 0.5) / (SR / 2), min(c * 1.6, SR / 2 - 300) / (SR / 2)], "band")
        if zi is None:
            zi = signal.lfilter_zi(b, a) * 0
        y, zi = signal.lfilter(b, a, noise[s0:s0 + seg], zi=zi)
        out[s0:s0 + seg] = y
    return out


def whoosh(dur=0.35, vel=0.3, lo=400, hi=6000):
    out = sweep_noise(dur, lo, hi, lambda p: np.sin(np.pi * p * 0.5))
    t = np.arange(len(out)) / SR
    return out * np.sin(np.pi * np.minimum(1, t / dur)) ** 1.5 * vel * 2


def swell(dur=1.5, vel=0.3, lo=200, hi=8000):
    out = sweep_noise(dur, lo, hi, lambda p: p ** 1.6)
    t = np.arange(len(out)) / SR
    return out * (t / dur) ** 2.4 * vel * 2


def impact(vel=0.8, length=2.4):
    n = int(length * SR)
    t = np.arange(n) / SR
    f = 30 + 55 * np.exp(-t * 10)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 2.6)
    body = lp(rng.standard_normal(n), 400) * np.exp(-t * 6) * 0.6
    air = hp(rng.standard_normal(n), 3000) * np.exp(-t * 9) * 0.12
    return np.tanh((boom + body + air) * 1.2) * vel


def thump(vel=0.5):
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    f = 50 + 70 * np.exp(-t * 40)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 16) * vel


def tick(vel=0.2, f=3200):
    n = int(0.03 * SR)
    t = np.arange(n) / SR
    return (bp(rng.standard_normal(n), f * 0.6, f * 1.6) * np.exp(-t * 400) + np.sin(2 * np.pi * f * 0.5 * t) * np.exp(-t * 300) * 0.3) * vel


def key(vel=0.16):
    """A soft laptop key: a short click with a little body."""
    n = int(0.05 * SR)
    t = np.arange(n) / SR
    click = bp(rng.standard_normal(n), 1800, 6500) * np.exp(-t * 260)
    body = lp(rng.standard_normal(n), 900) * np.exp(-t * 120) * 0.5
    return (click + body) * vel * (0.8 + 0.4 * rng.random())


def click(vel=0.3):
    n = int(0.07 * SR)
    t = np.arange(n) / SR
    x = bp(rng.standard_normal(n), 2000, 8000) * np.exp(-t * 520) + lp(rng.standard_normal(n), 700) * np.exp(-t * 150) * 0.7
    return x * vel


def stipple(dur=0.6, vel=0.14):
    n = int(dur * SR)
    g = bp(rng.standard_normal(n), 3500, 12000) * (rng.random(n) > 0.94)
    return g * np.linspace(1, 0, n) ** 1.5 * vel


def sparkle(dur=1.6, vel=0.12):
    n = int(dur * SR)
    g = hp(rng.standard_normal(n), 6000) * (rng.random(n) > 0.985)
    return g * np.exp(-np.arange(n) / SR * 2.2) * vel


# Hook.
add(impact(0.7), 0.0)
for k in range(0, 60, 2):
    add(tick(0.12 * (1 - k / 80), 2600 + (k % 3) * 300), fr("counter", k), pan=0.15 * np.sin(k))
for i in range(8):
    tb = START["strobe"] + i * 0.5
    add(whoosh(0.2, 0.22, 1500, 9000), tb - 0.06, pan=(-0.45 if i % 2 else 0.45))
    add(thump(0.45), tb)
    add(click(0.12), tb)
add(swell(3 * BEAT, 0.32, 300, 9000), START["wall"])
add(lp(rng.standard_normal(at(3)), 1500) * np.linspace(0.0, 0.12, at(3)), START["wall"])
# The question: near silence, one tick per word.
for bt in [0, 0.5, 1, 2, 2.5]:
    add(key(0.2), START["question"] + bt)

# Reveal.
for k in range(40):
    add(tick(0.05, 5000 + rng.random() * 3000), fr("sort", k * 0.5) + rng.random() * 0.02, pan=rng.uniform(-0.7, 0.7))
add(stipple(0.8, 0.12), fr("sort", 26))
add(stipple(0.5, 0.10), fr("sort", 60))
add(tick(0.10, 4200), fr("sort", 89))
add(swell(2 * BEAT, 0.3, 400, 10000), START["wordmark"] - 2)
add(impact(0.95), START["wordmark"])
add(sparkle(1.8, 0.14), START["wordmark"])

# Features: every type card enters on a whoosh and a soft thump.
for shot in ["triage", "summary", "draft", "ask", "tracking"]:
    add(whoosh(0.3, 0.24, 700, 7000), START[shot] - 0.12, pan=0.3)
    add(thump(0.4), START[shot])
    # ...and every cut from the card into the product.
    word = 1.5 if shot == "triage" else 2
    add(whoosh(0.4, 0.16, 300, 3000), START[shot] + word - 0.15, pan=-0.3)
for st in [1.5, 2.5, 3.5]:
    add(click(0.3), START["triage"] + 1.5 + st)
for a in [0, 8, 42, 62, 72, 98, 120]:
    add(stipple(0.6, 0.12), fr("summary", 60 + a), pan=0.2)
for k in range(34):
    add(key(0.1), fr("draft", 66 + k * 124 / 34), pan=0.1)
add(impact(0.35, 1.6), START["draft"] + 7)
press = START["draft"] + 9 + 8 / 30
add(click(0.55), press)
add(whoosh(0.55, 0.32, 500, 9000), press + 0.08, pan=0.4)
q_len = len("What did I promise Maya before Friday?")
for k in range(q_len):
    add(key(0.12), fr("ask", 66 + k / 24 * 60), pan=-0.1)
send_at = 6 + int(np.ceil(q_len / 24 * 60)) + 8
add(click(0.4), fr("ask", 60 + send_at))
for k in range(4):
    add(tick(0.08, 3600), fr("ask", 60 + send_at + 12 + k * 14.5))
add(stipple(1.0, 0.12), fr("ask", 60 + send_at + 80))
add(tick(0.2, 4200), fr("tracking", 80))
add(whoosh(0.3, 0.14, 1200, 6000), fr("tracking", 104))
add(click(0.3), fr("tracking", 178))

# Rapid fire.
for k in range(5):
    tb = START["rapid"] + k
    add(whoosh(0.2, 0.2, 1500, 9000), tb - 0.07, pan=(-0.4 if k % 2 else 0.4))
    add(thump(0.42), tb)
add(click(0.3), fr("rapid", 4 * 30 + 8))
add(click(0.25), fr("rapid", 2 * 30 + 10))
for k in range(4):
    add(whoosh(0.16, 0.15, 2500, 10000), START["rapid"] + 5 + k * 0.75 - 0.05)
add(swell(1.5 * BEAT, 0.3, 300, 9000), START["payoff"] - 1.5)
add(impact(0.6), START["payoff"])
add(lp(rng.standard_normal(at(4)), 2500) * np.sin(np.linspace(0, np.pi, at(4))) * 0.05, START["payoff"])

# Privacy: quiet; one key per line.
for bt in [0, 1.5, 3, 3.75]:
    add(key(0.2), START["privacy"] + bt)
add(swell(1.0 * BEAT * 2, 0.26, 300, 8000), START["end"] - 2)

# End.
add(impact(0.9, 3.0), START["end"])
add(sparkle(2.4, 0.1), START["end"])

mix = np.stack([L, R])
room = lp(hp(rng.standard_normal((2, LENGTH)), 80), 900) * 0.004
mix = hp(mix, 25) + room
peak = np.max(np.abs(mix))
mix = np.tanh(mix / peak * 1.3) / np.tanh(1.3) * 0.89
fade = int(1.0 * SR)
mix[:, -fade:] *= np.linspace(1, 0, fade)
out = os.path.join(ROOT, "public/kinetic/sfx.wav")
wavfile.write(out, SR, (mix.T * 32767).astype(np.int16))
print("wrote", out, LENGTH / SR, "s")
