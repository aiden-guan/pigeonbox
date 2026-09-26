"""Composite each shot's parallax plates at a camera position for visual QA."""
import json, os, sys
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
A = os.path.join(ROOT, 'public', 'art')
M = json.load(open(os.path.join(ROOT, 'src', 'art-manifest.json')))
out = sys.argv[1]
t = float(sys.argv[2]) if len(sys.argv) > 2 else 0.3
def shot(prefix, names, W, H):
    travel = M[prefix]['travel']
    im = Image.new('RGBA', (W, H))
    for n in names:
        meta = M[f'{prefix}_{n}']
        layer = Image.open(os.path.join(A, f'{prefix}_{n}.png'))
        x = -int(travel * t * meta['parallax'])
        im.alpha_composite(layer, (x, 0)) if x >= 0 else im.alpha_composite(layer.crop((-x, 0, -x + W, H)))
    return im
tiles = [
    shot('j1', ['sky', 'far', 'mid', 'near', 'fg'], 480, 270),
    shot('j2', ['sky', 'far', 'near', 'fg'], 480, 270),
    shot('j3', ['sky', 'far', 'mid', 'near'], 480, 270),
    shot('j4', ['sky', 'l1', 'l2', 'l3', 'l4'], 640, 360).resize((480, 270), Image.NEAREST),
    shot('j5', ['sky', 'far', 'near', 'fg'], 480, 270),
]
s1 = Image.open(os.path.join(A, 's1_outside.png')).convert('RGBA')
s1.alpha_composite(Image.open(os.path.join(A, 's1_room.png')))
s1.alpha_composite(Image.open(os.path.join(A, 's1_person.png')))
tiles.append(s1.resize((480, 270), Image.NEAREST))
sheet = Image.new('RGB', (960, 270 * 3))
for i, tl in enumerate(tiles):
    sheet.paste(tl.convert('RGB'), ((i % 2) * 480, (i // 2) * 270))
sheet.resize((1920, 1620), Image.NEAREST).save(out)
f = Image.new('RGB', (640, 180))
s3 = Image.open(os.path.join(A, 's3_facade.png')).convert('RGBA')
snd = M['s3_sender']
s3.alpha_composite(Image.open(os.path.join(A, 's3_sender.png')).crop((0, 0, snd['cw'], snd['ch'])), tuple(snd['at']))
for layer in ('s3_front', 's3_mug'):
    s3.alpha_composite(Image.open(os.path.join(A, f'{layer}.png')), tuple(snd['at']))
f.paste(s3.convert('RGB'), (0, 0))
f.paste(Image.open(os.path.join(A, 'r1_facade.png')).convert('RGB'), (320, 0))
f.resize((1920, 540), Image.NEAREST).save(out.replace('.png', '_facades.png'))
