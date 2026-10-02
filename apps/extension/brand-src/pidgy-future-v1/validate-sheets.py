"""Inspect generated PNGs without modifying their pixels or alpha channel."""
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent
SETS = {
    "cozy": ("Cozy Pidgy", ["Tea sip", "Sleepy rest"]),
    "delivery": ("Mail adventures", ["Present a parcel", "Paper airplane"]),
    "cheer": ("Little celebrations", ["Friendly wave", "Star celebration"]),
    "explorer": ("Curious explorer", ["Read a map", "Curious lantern"]),
}
MIN_GUTTER = 16
MIN_VISIBLE_ALPHA = 4


def validate():
    sheets, checks = [], []
    for name, (title, rows) in SETS.items():
        relative = f"sheets/pidgy-{name}.png"
        with Image.open(ROOT / relative) as image:
            assert image.mode == "RGBA", f"{name}: expected a real alpha channel"
            width, height = image.size
            # Image Gen can choose dimensions not divisible by the requested grid.
            # Partition using measured integer edges, preserving every source pixel.
            x_edges = [width * col // 4 for col in range(5)]
            y_edges = [height * row // 2 for row in range(3)]
            alpha = image.getchannel("A")
            assert alpha.getextrema()[0] == 0, f"{name}: no transparent pixels"
            # Alpha 1-3 is under 1.2% opacity: generated empty space can contain
            # this residual noise. This mask is analysis-only; source alpha stays intact.
            visible = alpha.point(lambda value: 255 if value >= MIN_VISIBLE_ALPHA else 0)
            frames = []
            for row in range(2):
                for col in range(4):
                    x, y = x_edges[col], y_edges[row]
                    cell_w, cell_h = x_edges[col + 1] - x, y_edges[row + 1] - y
                    # This is an analysis window only. The artwork is not edited.
                    bounds = visible.crop((x, y, x + cell_w, y + cell_h)).getbbox()
                    assert bounds is not None, f"{name}: empty frame {row},{col}"
                    left, top, right, bottom = bounds
                    padding = {"left": left, "top": top, "right": cell_w - right,
                               "bottom": cell_h - bottom}
                    assert min(padding.values()) >= MIN_GUTTER, (
                        f"{name}: frame {row},{col} touches safe gutter: {padding}"
                    )
                    occupied = alpha.crop((x, y, x + cell_w, y + cell_h)).histogram()
                    frames.append({
                        "index": row * 4 + col, "row": row, "column": col,
                        "design": rows[row], "pose": col + 1,
                        "rect": {"x": x, "y": y, "width": cell_w, "height": cell_h},
                        "contentBounds": {"x": x + left, "y": y + top,
                                          "width": right - left, "height": bottom - top},
                        "visibleContentPadding": padding,
                        "nonzeroAlphaPixels": sum(occupied[1:]),
                        "residualAlphaNoisePixels": sum(occupied[1:MIN_VISIBLE_ALPHA]),
                    })
            minimum = min(min(f["visibleContentPadding"].values()) for f in frames)
            checks.append({"sheet": name, "frames": len(frames),
                           "minimumVisibleContentGutterPx": minimum, "passed": True})
            sheets.append({"id": name, "title": title, "file": relative,
                           "width": width, "height": height, "columns": 4, "rows": 2,
                           "nominalCellWidth": width / 4, "nominalCellHeight": height / 2,
                           "animations": [{"name": label, "frames": list(range(row * 4, row * 4 + 4)),
                                           "previewFrameDurationMs": 240}
                                          for row, label in enumerate(rows)],
                           "frames": frames})
    manifest = {"version": 1,
        "generation": "built-in Image Gen", "purpose": "Future Pidgy designs",
        "sheets": sheets}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # A plain script also lets the gallery work when opened directly from disk.
    (ROOT / "manifest.js").write_text("window.pidgyManifest = " + json.dumps(manifest) + ";\n")
    result = {"passed": True, "frameCount": sum(c["frames"] for c in checks),
              "requiredVisibleContentGutterPx": MIN_GUTTER,
              "contentBoundsMinimumAlpha": MIN_VISIBLE_ALPHA,
              "residualAlpha": "Values 1-3 are recorded as noise; source alpha is preserved",
              "pixelEdits": False, "sheets": checks}
    (ROOT / "validation.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    validate()
