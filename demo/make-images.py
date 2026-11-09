"""Crops the raw screenshots of the demo into the README images and builds the replay GIF.
Usage: python demo/make-images.py   (needs Pillow; raw shots come from Chrome at 1.25 device pixels per CSS pixel)
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "docs" / "images"
FRAMES = ROOT / "demo" / "data" / "frames"
DPR = 1.25


def box(x0, y0, x1, y1):
    """A crop box in CSS pixels, as device pixels."""
    return tuple(round(v * DPR) for v in (x0, y0, x1, y1))


def save(im, name, width):
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.convert("RGB").save(IMG / name, optimize=True)
    print(name, im.size)


# raw-<name>.png: a screenshot to crop, if it was taken this time; the window was 1536 x 720 CSS pixels
JOBS = [("map", None, "swarm-map.png", 1600), ("dark", None, "dark-mode.png", 1600),
        ("full-timeline", (330, 173, 1161, 728), "timeline.png", 1100), ("full-story", (331, 604, 1160, 1182), "prompt-story.png", 1100),
        ("drawer", (760, 0, 1536, 720), "agent-details.png", 1100)]
for name, crop, target, width in JOBS:
    src = IMG / f"raw-{name}.png"
    if src.exists():
        im = Image.open(src)
        save(im.crop(box(*crop)) if crop else im, target, width)

# the replay: the control bar, the sessions list and the map, frame by frame
frames = []
for f in sorted(FRAMES.glob("f*.png")):
    im = Image.open(f).crop(box(18, 20, 1503, 716)).convert("RGB")
    im = im.resize((1000, round(im.height * 1000 / im.width)), Image.LANCZOS)
    frames.append(im.quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
durations = [900] + [650] * (len(frames) - 2) + [2600]   # hold the first and the last frame
frames[0].save(IMG / "replay.gif", save_all=True, append_images=frames[1:], duration=durations, loop=0, optimize=True)
print("replay.gif", frames[0].size, len(frames), "frames")
