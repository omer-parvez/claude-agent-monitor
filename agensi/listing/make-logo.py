"""Draws the session-replay logo: a blue main agent handing work to three orange subagents, over timeline bars,
with a play button. Writes agensi/listing/logo.png (512 x 512) and logo-256.png.
Usage: python agensi/listing/make-logo.py   (needs Pillow)
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
S = 2048                     # drawn large, then scaled down for smooth edges
BG, BLUE, ORANGE, LINE, BAR = "#14161c", "#3987e5", "#eb6834", "#5a6070", "#2a2e38"

im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((0, 0, S - 1, S - 1), radius=420, fill=BG)


def u(v):
    return round(v * S / 512)


# timeline bars behind the agents: one per agent, like the Timeline view
for y, x0, x1 in [(150, 112, 300), (226, 210, 400), (302, 236, 420), (378, 222, 360)]:
    d.rounded_rectangle((u(x0), u(y - 9), u(x1), u(y + 9)), radius=u(9), fill=BAR)

# links from the main agent to each subagent
main = (u(128), u(264))
subs = [(u(330), u(170)), (u(372), u(272)), (u(320), u(372))]
for sx, sy in subs:
    d.line((main, (sx, sy)), fill=LINE, width=u(10))

# the agents
r = u(62)
d.ellipse((main[0] - r, main[1] - r, main[0] + r, main[1] + r), fill=BLUE)
for sx, sy in subs:
    rs = u(38)
    d.ellipse((sx - rs, sy - rs, sx + rs, sy + rs), fill=ORANGE)

# play button on the main agent: it's a replay
p = u(26)
d.polygon([(main[0] - p * 0.7, main[1] - p), (main[0] - p * 0.7, main[1] + p), (main[0] + p, main[1])], fill="white")

im.resize((512, 512), Image.LANCZOS).save(OUT / "logo.png", optimize=True)
im.resize((256, 256), Image.LANCZOS).save(OUT / "logo-256.png", optimize=True)
print("logo.png, logo-256.png")
