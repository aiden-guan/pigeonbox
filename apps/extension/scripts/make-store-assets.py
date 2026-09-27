"""Build the Chrome Web Store images from real PigeonBox UI.

Screenshots (1280x800) put the README feature captures, which are the real
extension UI with fictional mail, on a branded canvas with a headline. The
small promo tile (440x280) and marquee (1400x560) use the idle pigeon.

Usage: python3 apps/extension/scripts/make-store-assets.py   (macOS: uses Avenir Next)
Writes docs/store/.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[3]
EXT = ROOT / 'apps/extension'
CAPTURES = ROOT / 'assets/readme'
OUT = ROOT / 'docs/store'
FONT = '/System/Library/Fonts/Avenir Next.ttc'
DEMI, MEDIUM, REGULAR = 2, 5, 7

INK = (244, 240, 233)
MUTED = (183, 173, 160)
COPPER = (224, 163, 123)
BG_TOP = (27, 24, 20)
BG_BOTTOM = (14, 13, 11)

SHOTS = [
    ('feature-triage.png', 'On your computer', 'Your inbox,\nsorted.', 'Respond, Waiting, FYI and Notifications, sorted in your browser. Works even with AI turned off.'),
    ('feature-companion.png', 'Thread companion', 'The important\nbits, up front.', 'A summary, dates, key details and to-dos beside every conversation.'),
    ('feature-drafting.png', 'Drafts, not sends', 'Replies in\nyour voice.', 'Drafts open in Gmail for you to review and send. PigeonBox never sends mail.'),
    ('feature-ask.png', 'Ask your inbox', 'Ask, and get\nan answer.', '"What needs a reply?" answered from mail already on this computer.'),
]


def font(index: int, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size, index=index)


def background(size: tuple[int, int], glow_at: tuple[int, int]) -> Image.Image:
    w, h = size
    base = Image.new('RGB', size)
    draw = ImageDraw.Draw(base)
    for y in range(h):
        t = y / (h - 1)
        draw.line([(0, y), (w, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))
    glow = Image.new('L', size, 0)
    r = int(max(size) * 0.42)
    ImageDraw.Draw(glow).ellipse((glow_at[0] - r, glow_at[1] - r, glow_at[0] + r, glow_at[1] + r), fill=70)
    glow = glow.filter(ImageFilter.GaussianBlur(r // 2))
    return Image.composite(Image.new('RGB', size, (120, 78, 48)), base, glow)


def rounded(image: Image.Image, radius: int) -> Image.Image:
    mask = Image.new('L', image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, image.width - 1, image.height - 1), radius, fill=255)
    out = image.convert('RGBA')
    out.putalpha(mask)
    return out


def paste_with_shadow(canvas: Image.Image, card: Image.Image, at: tuple[int, int]) -> None:
    shadow = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    silhouette = Image.new('RGBA', card.size, (0, 0, 0, 150))
    silhouette.putalpha(card.getchannel('A').point(lambda a: a * 150 // 255))
    shadow.paste(silhouette, (at[0], at[1] + 18), silhouette)
    shadow = shadow.filter(ImageFilter.GaussianBlur(28))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(card, at)


def wrap(draw: ImageDraw.ImageDraw, text: str, face: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines, line = [], ''
    for word in text.split():
        trial = f'{line} {word}'.strip()
        if draw.textlength(trial, font=face) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line]


def pigeon() -> Image.Image:
    cell = Image.open(EXT / 'public/brand/pigeon-sprites.png').convert('RGBA').crop((0, 0, 320, 256))
    return cell.crop(cell.getchannel('A').point(lambda a: 255 if a > 24 else 0).getbbox())


def pixel_scale(image: Image.Image, height: int) -> Image.Image:
    return image.resize((round(image.width * height / image.height), height), Image.LANCZOS)


def screenshot(capture: str, kicker: str, headline: str, body: str) -> Image.Image:
    size = (1280, 800)
    canvas = background(size, (930, 380)).convert('RGBA')
    draw = ImageDraw.Draw(canvas)
    panel = Image.open(CAPTURES / capture)
    panel = rounded(panel, 44)
    panel = panel.resize((round(panel.width * 700 / panel.height), 700), Image.LANCZOS)
    paste_with_shadow(canvas, panel, (1280 - 110 - panel.width, 50))

    x, y = 96, 196
    draw.text((x, y), kicker.upper(), font=font(DEMI, 20), fill=COPPER, spacing=0)
    y += 52
    head = font(DEMI, 66)
    for line in headline.split('\n'):
        draw.text((x, y), line, font=head, fill=INK)
        y += 80
    y += 26
    sub = font(REGULAR, 27)
    for line in wrap(draw, body, sub, 560):
        draw.text((x, y), line, font=sub, fill=MUTED)
        y += 40
    bird = pixel_scale(pigeon(), 64)
    canvas.alpha_composite(bird, (x, 800 - 96 - bird.height))
    draw.text((x + bird.width + 16, 800 - 96 - bird.height + 14), 'PigeonBox', font=font(DEMI, 28), fill=INK)
    return canvas.convert('RGB')


def tile(size: tuple[int, int], headline_size: int, tagline: str, tagline_size: int) -> Image.Image:
    w, h = size
    canvas = background(size, (int(w * 0.28), int(h * 0.5))).convert('RGBA')
    draw = ImageDraw.Draw(canvas)
    bird = pixel_scale(pigeon(), int(h * 0.54))
    bx = int(w * 0.08)
    canvas.alpha_composite(bird, (bx, (h - bird.height) // 2))
    tx = bx + bird.width + int(w * 0.045)
    head = font(DEMI, headline_size)
    sub = font(MEDIUM, tagline_size)
    lines = wrap(draw, tagline, sub, w - tx - int(w * 0.06))
    block = headline_size * 1.15 + len(lines) * tagline_size * 1.35
    ty = (h - block) / 2
    draw.text((tx, ty), 'PigeonBox', font=head, fill=INK)
    ty += headline_size * 1.15 + tagline_size * 0.3
    for line in lines:
        draw.text((tx, ty), line, font=sub, fill=MUTED)
        ty += tagline_size * 1.35
    return canvas.convert('RGB')


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for index, shot in enumerate(SHOTS, start=1):
        path = OUT / f'screenshot-{index}.png'
        screenshot(*shot).save(path, optimize=True)
        print(f'wrote {path.relative_to(ROOT)}')
    tile((440, 280), 38, 'AI inbox help for Gmail, on your computer.', 18).save(OUT / 'promo-small.png', optimize=True)
    tile((1400, 560), 104, 'AI inbox help and open tracking for Gmail. Runs on your computer.', 40).save(OUT / 'promo-marquee.png', optimize=True)
    print('wrote docs/store/promo-small.png, docs/store/promo-marquee.png')
    # Store icon: 128x128 with the artwork inside the central 96x96, as the store's image guidelines ask.
    bird = pigeon()
    bird = bird.resize((round(bird.width * 96 / max(bird.size)), round(bird.height * 96 / max(bird.size))), Image.LANCZOS)
    icon = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
    icon.alpha_composite(bird, ((128 - bird.width) // 2, (128 - bird.height) // 2))
    icon.save(OUT / 'store-icon-128.png', optimize=True)
    print('wrote docs/store/store-icon-128.png')


if __name__ == '__main__':
    main()
