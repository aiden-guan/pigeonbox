"""Build the Chrome Web Store images from real PigeonBox UI.

Screenshots (1280x800) pair real extension screens with a warm editorial
layout. Both promo tiles use real extension UI in a matching paper-and-copper
layout, with the required 440x280 and 1400x560 canvases.

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

PAPER_TOP = (246, 239, 228)
PAPER_BOTTOM = (234, 222, 206)
STORE_INK = (43, 37, 31)
STORE_MUTED = (111, 99, 86)
STORE_COPPER = (176, 105, 64)
STORE_COPPER_LIGHT = (224, 163, 123)

SHOTS = [
    {
        'capture': CAPTURES / 'feature-triage.png',
        'glow': (920, 400), 'panel': (740, 49, 458, 700),
        'label': 'Inbox sorting', 'headline': 'Mail, sorted\ninto place.',
        'body': 'Respond, Waiting, FYI and Notifications in one clear view.',
        'copy': (86, 230, 520, 61), 'flight': ((525, 210), (666, 102), (730, 130)),
    },
    {
        'capture': CAPTURES / 'feature-companion.png',
        'glow': (350, 410), 'panel': (80, 88, 468, 660),
        'label': 'Thread companion', 'headline': 'A whole thread,\nmade clear.',
        'body': 'Catch the summary, dates, key details and a clear next step beside the conversation.',
        'copy': (630, 258, 530, 57), 'flight': ((510, 625), (634, 718), (712, 658)),
    },
    {
        'capture': CAPTURES / 'feature-ask.png',
        'glow': (935, 385), 'panel': (740, 48, 458, 703),
        'label': 'Ask your inbox', 'headline': 'Ask your inbox\nwhat matters.',
        'body': 'Find a detail or pick up a conversation from mail already on this computer.',
        'copy': (82, 248, 525, 57),
    },
    {
        'capture': CAPTURES / 'feature-companion.png',
        'crop': (0, 680, 752, 1130), 'glow': (900, 640),
        'panel': (548, 180, 670, 575), 'panel_radius': 24,
        'label': 'Drafts you review', 'headline': 'A little help\nwith the reply.',
        'body': 'Start with a draft, then review every word before it goes into Gmail.',
        'copy': (86, 247, 378, 51), 'note': 'PigeonBox never sends mail',
    },
    {
        'capture': ROOT / 'launch-video/public/product/onboarding.png',
        'crop': (960, 110, 1920, 1370), 'glow': (915, 410),
        'panel': (740, 58, 458, 700),
        'label': 'Meet PigeonBox', 'headline': 'Your mail,\nin good wings.',
        'body': 'Meet PigeonBox, your thoughtful little companion for Gmail.',
        'copy': (86, 250, 535, 61),
    },
]


def font(index: int, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size, index=index)


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


def store_background(glow_at: tuple[int, int]) -> Image.Image:
    size = (1280, 800)
    base = Image.new('RGB', size)
    draw = ImageDraw.Draw(base)
    for y in range(size[1]):
        t = y / (size[1] - 1)
        row = tuple(round(a + (b - a) * t) for a, b in zip(PAPER_TOP, PAPER_BOTTOM))
        draw.line([(0, y), (size[0], y)], fill=row)
    glow = Image.new('L', size, 0)
    radius = 360
    ImageDraw.Draw(glow).ellipse(
        (glow_at[0] - radius, glow_at[1] - radius, glow_at[0] + radius, glow_at[1] + radius),
        fill=36,
    )
    glow = glow.filter(ImageFilter.GaussianBlur(125))
    return Image.composite(Image.new('RGB', size, (231, 189, 153)), base, glow).convert('RGBA')


def crisp_pigeon(height: int) -> Image.Image:
    image = pigeon()
    return image.resize(
        (round(image.width * height / image.height), height),
        Image.Resampling.NEAREST,
    )


def store_header(canvas: Image.Image, index: int) -> None:
    draw = ImageDraw.Draw(canvas)
    canvas.alpha_composite(crisp_pigeon(34), (82, 7))
    draw.text((126, 8), 'PigeonBox', font=font(DEMI, 19), fill=STORE_INK)
    draw.text((128, 31), 'FOR GMAIL', font=font(MEDIUM, 9), fill=STORE_MUTED)
    draw.rounded_rectangle((1070, 16, 1193, 20), radius=2, fill=(210, 191, 168, 255))
    draw.rounded_rectangle(
        (1070, 16, 1070 + round(123 * index / len(SHOTS)), 20),
        radius=2,
        fill=STORE_COPPER_LIGHT + (255,),
    )
    draw.text((1200, 9), f'{index:02d}', font=font(MEDIUM, 15), fill=STORE_MUTED)


def feature_copy(
    canvas: Image.Image,
    x: int,
    y: int,
    label: str,
    headline: str,
    body: str,
    width: int,
    headline_size: int,
    note: str | None = None,
) -> None:
    draw = ImageDraw.Draw(canvas)
    label_font = font(MEDIUM, 15)
    label_width = draw.textlength(label.upper(), font=label_font)
    draw.rounded_rectangle(
        (x, y, x + label_width + 30, y + 34), radius=17,
        fill=(239, 220, 198, 255), outline=(220, 192, 162, 255), width=1,
    )
    draw.text((x + 15, y + 8), label.upper(), font=label_font, fill=STORE_COPPER)
    y += 66

    heading_font = font(DEMI, headline_size)
    for line in headline.split('\n'):
        draw.text((x, y), line, font=heading_font, fill=STORE_INK)
        y += int(headline_size * 1.16)
    y += 18

    body_font = font(REGULAR, 24)
    for line in wrap(draw, body, body_font, width):
        draw.text((x, y), line, font=body_font, fill=STORE_MUTED)
        y += 36

    if note:
        y += 28
        note_font = font(MEDIUM, 13)
        note_width = draw.textlength(note.upper(), font=note_font)
        draw.rounded_rectangle(
            (x, y, x + note_width + 28, y + 32), radius=16,
            fill=(246, 230, 212, 255),
        )
        draw.text((x + 14, y + 8), note.upper(), font=note_font, fill=STORE_COPPER)


def paste_ui_panel(
    canvas: Image.Image,
    capture: Path,
    rect: tuple[int, int, int, int],
    crop: tuple[int, int, int, int] | None = None,
    radius: int = 26,
) -> None:
    x, y, box_width, box_height = rect
    image = Image.open(capture).convert('RGBA')
    if crop:
        image = image.crop(crop)
    pad = 7 if radius == 26 else 8
    max_width, max_height = box_width - 2 * pad, box_height - 2 * pad
    scale = min(max_width / image.width, max_height / image.height)
    size = (round(image.width * scale), round(image.height * scale))
    image = image.resize(size, Image.Resampling.LANCZOS)

    card = Image.new('RGBA', (size[0] + 2 * pad, size[1] + 2 * pad), (255, 251, 244, 255))
    image_mask = Image.new('L', image.size, 0)
    ImageDraw.Draw(image_mask).rounded_rectangle(
        (0, 0, image.width - 1, image.height - 1), max(8, radius - pad), fill=255,
    )
    image.putalpha(image_mask)
    card.alpha_composite(image, (pad, pad))
    card_mask = Image.new('L', card.size, 0)
    ImageDraw.Draw(card_mask).rounded_rectangle(
        (0, 0, card.width - 1, card.height - 1), radius, fill=255,
    )
    card.putalpha(card_mask)

    shadow = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    silhouette = Image.new('RGBA', card.size, (65, 47, 32, 85))
    silhouette.putalpha(card.getchannel('A').point(lambda alpha: alpha * 92 // 255))
    shadow.alpha_composite(silhouette, (x, y + 14))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(22)))
    canvas.alpha_composite(card, (x, y))


def flight_path(canvas: Image.Image, points: tuple[tuple[int, int], tuple[int, int], tuple[int, int]]) -> None:
    draw = ImageDraw.Draw(canvas)
    (x0, y0), (x1, y1), (x2, y2) = points
    for i in range(0, 101, 9):
        t = i / 100
        x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * x1 + t**2 * x2
        y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * y1 + t**2 * y2
        draw.ellipse((int(x - 4), int(y - 4), int(x + 4), int(y + 4)), fill=(188, 132, 94, 95))


def screenshot(spec: dict, index: int) -> Image.Image:
    canvas = store_background(spec['glow'])
    if spec.get('flight'):
        flight_path(canvas, spec['flight'])
    x, y, width, size = spec['copy']
    feature_copy(
        canvas, x, y, spec['label'], spec['headline'], spec['body'], width, size,
        spec.get('note'),
    )
    paste_ui_panel(
        canvas, spec['capture'], spec['panel'], spec.get('crop'), spec.get('panel_radius', 26),
    )
    store_header(canvas, index)
    return canvas.convert('RGB')


def promo_background(size: tuple[int, int]) -> Image.Image:
    w, h = size
    base = Image.new('RGB', size)
    draw = ImageDraw.Draw(base)
    for y in range(h):
        t = y / max(1, h - 1)
        row = tuple(round(a + (b - a) * t) for a, b in zip(PAPER_TOP, PAPER_BOTTOM))
        draw.line([(0, y), (w, y)], fill=row)
    glow = Image.new('L', size, 0)
    radius = round(max(size) * 0.48)
    ImageDraw.Draw(glow).ellipse(
        (round(w * 0.78) - radius, round(h * 0.48) - radius,
         round(w * 0.78) + radius, round(h * 0.48) + radius),
        fill=40,
    )
    glow = glow.filter(ImageFilter.GaussianBlur(max(1, radius // 2)))
    warm = Image.new('RGB', size, (255, 247, 235))
    canvas = Image.composite(warm, base, glow).convert('RGBA')
    ImageDraw.Draw(canvas).rounded_rectangle(
        (10, 10, w - 11, h - 11), radius=min(28, h // 12),
        outline=(255, 251, 245, 220), width=2,
    )
    return canvas


def promo_lockup(canvas: Image.Image, x: int, y: int, bird_height: int, brand_size: int) -> None:
    bird = crisp_pigeon(bird_height)
    canvas.alpha_composite(bird, (x, y))
    draw = ImageDraw.Draw(canvas)
    tx = x + bird.width + 10
    draw.text((tx, y - 1), 'PigeonBox', font=font(DEMI, brand_size), fill=STORE_INK)
    draw.text((tx + 1, y + brand_size + 1), 'FOR GMAIL', font=font(MEDIUM, max(8, brand_size // 2)), fill=STORE_MUTED)


def promo_small() -> Image.Image:
    canvas = promo_background((440, 280))
    promo_lockup(canvas, 23, 19, 30, 18)

    draw = ImageDraw.Draw(canvas)
    draw.text((23, 78), 'LESS INBOX NOISE', font=font(MEDIUM, 10), fill=STORE_COPPER)
    heading = font(DEMI, 29)
    draw.text((22, 105), 'A calmer', font=heading, fill=STORE_INK)
    draw.text((22, 139), 'inbox.', font=heading, fill=STORE_INK)

    body = font(REGULAR, 14)
    y = 188
    for line in wrap(draw, 'Sort the busy bits and draft replies you review.', body, 220):
        draw.text((23, y), line, font=body, fill=STORE_MUTED)
        y += 19

    paste_ui_panel(
        canvas, CAPTURES / 'feature-triage.png', (271, 27, 156, 226), radius=16,
    )
    return canvas.convert('RGB')


def promo_marquee() -> Image.Image:
    canvas = promo_background((1400, 560))
    promo_lockup(canvas, 91, 39, 48, 27)

    draw = ImageDraw.Draw(canvas)
    draw.text((96, 143), 'YOUR THOUGHTFUL GMAIL SIDEKICK', font=font(MEDIUM, 15), fill=STORE_COPPER)
    heading = font(DEMI, 65)
    draw.text((91, 184), 'A calmer inbox,', font=heading, fill=STORE_INK)
    draw.text((91, 259), 'right inside Gmail.', font=heading, fill=STORE_INK)

    body = font(REGULAR, 24)
    y = 365
    for line in wrap(
        draw, 'Sort the busy bits, untangle threads, and draft replies you review.', body, 640,
    ):
        draw.text((96, y), line, font=body, fill=STORE_MUTED)
        y += 34

    chips = ['INBOX SORTING', 'THREAD SUMMARIES', 'YOU REVIEW EVERY DRAFT']
    x = 95
    chip_y = 478
    chip_font = font(MEDIUM, 12)
    for label in chips:
        width = round(draw.textlength(label, font=chip_font))
        draw.rounded_rectangle(
            (x, chip_y, x + width + 28, chip_y + 34), radius=17,
            fill=(239, 220, 198, 255), outline=(220, 192, 162, 255), width=1,
        )
        draw.text((x + 14, chip_y + 9), label, font=chip_font, fill=STORE_COPPER)
        x += width + 42

    flight_path(canvas, ((752, 420), (841, 391), (897, 293)))
    paste_ui_panel(
        canvas, CAPTURES / 'feature-triage.png', (1000, 40, 360, 480), radius=28,
    )
    return canvas.convert('RGB')


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for index, shot in enumerate(SHOTS, start=1):
        path = OUT / f'screenshot-{index}.png'
        screenshot(shot, index).save(path, optimize=True)
        print(f'wrote {path.relative_to(ROOT)}')
    promo_small().save(OUT / 'promo-small.png', optimize=True)
    promo_marquee().save(OUT / 'promo-marquee.png', optimize=True)
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
