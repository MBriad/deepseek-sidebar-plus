from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
ICONS = ROOT / "icons"
STORE = ROOT / "docs" / "store"
ICONS.mkdir(exist_ok=True)
STORE.mkdir(parents=True, exist_ok=True)

SIZE = 1024

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def gradient(size, top, bottom):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        color = lerp(top, bottom, y / max(1, size - 1))
        for x in range(size):
            px[x, y] = color
    return img

def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask

# Rounded-square background with a soft blue-violet gradient.
canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bg = gradient(SIZE, (74, 103, 255), (119, 77, 245)).convert("RGBA")
bg.putalpha(rounded_mask(SIZE, 220))

# Soft top-left highlight.
glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse((-260, -360, 760, 620), fill=(255, 255, 255, 44))
glow = glow.filter(ImageFilter.GaussianBlur(90))
bg.alpha_composite(glow)
canvas.alpha_composite(bg)

# Chat bubble + tail, with a subtle shadow.
shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle((150, 205, 875, 720), radius=110, fill=(18, 28, 90, 95))
sd.polygon([(235, 680), (235, 858), (405, 720)], fill=(18, 28, 90, 95))
shadow = shadow.filter(ImageFilter.GaussianBlur(28))
canvas.alpha_composite(shadow, (0, 18))

bubble = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
bd = ImageDraw.Draw(bubble)
bd.rounded_rectangle((150, 190, 875, 705), radius=110, fill=(255, 255, 255, 255))
bd.polygon([(235, 665), (235, 843), (405, 705)], fill=(255, 255, 255, 255))
canvas.alpha_composite(bubble)

# Left sidebar panel inside the bubble.
panel = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
pd = ImageDraw.Draw(panel)
pd.rounded_rectangle((205, 245, 365, 650), radius=46, fill=(232, 237, 255, 255))
canvas.alpha_composite(panel)

# Prompt chevron ">" on the sidebar panel.
chevron = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
cd = ImageDraw.Draw(chevron)
cd.line([(255, 385), (318, 447), (255, 509)], fill=(45, 62, 145, 255), width=30, joint="curve")
# Small command dot.
cd.ellipse((292, 535, 326, 569), fill=(45, 62, 145, 255))
canvas.alpha_composite(chevron)

# Three text lines on the right, like a document/chat.
lines = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ld = ImageDraw.Draw(lines)
ld.rounded_rectangle((430, 300, 790, 342), radius=21, fill=(77, 107, 254, 255))
ld.rounded_rectangle((430, 395, 700, 437), radius=21, fill=(143, 159, 255, 255))
ld.rounded_rectangle((430, 490, 755, 532), radius=21, fill=(77, 107, 254, 255))
# Accent sparkle bottom-right.
ld.rounded_rectangle((760, 590, 798, 628), radius=8, fill=(122, 77, 245, 255))
ld.rounded_rectangle((744, 606, 814, 612), radius=3, fill=(122, 77, 245, 255))
ld.rounded_rectangle((776, 574, 782, 644), radius=3, fill=(122, 77, 245, 255))
canvas.alpha_composite(lines)

# Save the master and extension icon sizes.
canvas.save(STORE / "icon-master.png")
for size in (16, 32, 48, 128):
    target = canvas.resize((size, size), Image.LANCZOS)
    target.save(ICONS / f"icon{size}.png")

print("saved", [f"icon{s}.png" for s in (16, 32, 48, 128)], "and icon-master.png")
