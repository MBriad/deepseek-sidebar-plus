from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
STORE = ROOT / "docs" / "store"
STORE.mkdir(parents=True, exist_ok=True)
icon = Image.open(ROOT / "icons" / "icon128.png").convert("RGBA")

def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

CN_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
CN = r"C:\Windows\Fonts\msyh.ttc"
EN_BOLD = r"C:\Windows\Fonts\segoeuib.ttf"
EN = r"C:\Windows\Fonts\segoeui.ttf"

def gradient(size, top, bottom):
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = round(top[0] + (bottom[0] - top[0]) * t)
        g = round(top[1] + (bottom[1] - top[1]) * t)
        b = round(top[2] + (bottom[2] - top[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img

def rounded_icon(size):
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bg = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=size // 5, fill=255)
    base.paste(bg, (0, 0), mask)
    inner = icon.resize((round(size * 0.72), round(size * 0.72)), Image.LANCZOS)
    # soft shadow
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sw, sh = inner.size
    sx = (size - sw) // 2
    sy = (size - sh) // 2 + 4
    sd.rounded_rectangle((sx, sy, sx + sw, sy + sh), radius=18, fill=(31, 45, 70, 70))
    shadow = shadow.filter(ImageFilter.GaussianBlur(10))
    base.alpha_composite(shadow)
    base.alpha_composite(inner, ((size - sw) // 2, (size - sh) // 2))
    return base

# 1) Store logo 300x300
logo = rounded_icon(300)
logo.save(STORE / "logo-300.png")

def draw_badge(draw, xy, text, font, fill=(255, 255, 255), bg=(77, 107, 254)):
    x, y = xy
    bbox = draw.textbbox((0, 0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    pad_x, pad_y = 12, 6
    draw.rounded_rectangle((x, y, x + w + pad_x * 2, y + h + pad_y * 2), radius=(h + pad_y * 2) // 2, fill=bg)
    draw.text((x + pad_x, y + pad_y - bbox[1]), text, font=font, fill=fill)
    return x + w + pad_x * 2

def icon_tile(size):
    img = gradient(size, (15, 23, 42), (30, 49, 84)).convert("RGBA")
    # subtle glow
    glow = Image.new("RGBA", size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-size[0] * 0.2, -size[1] * 0.5, size[0] * 0.9, size[1] * 0.9), fill=(77, 107, 254, 70))
    glow = glow.filter(ImageFilter.GaussianBlur(55))
    img.alpha_composite(glow)
    return img

# 2) Small promo tile 440x280
small = icon_tile((440, 280))
d = ImageDraw.Draw(small)
ic = icon.resize((104, 104), Image.LANCZOS)
small.alpha_composite(ic, (28, 66))
title_f = font(CN_BOLD, 26)
sub_f = font(CN, 14)
tag_f = font(CN, 12)
badge_f = font(EN_BOLD, 10)
d.text((150, 64), "DeepSeek Sidebar+", font=font(EN_BOLD, 20), fill=(255, 255, 255))
d.text((150, 94), "侧边栏增强版（非官方）", font=title_f, fill=(255, 255, 255))
d.text((150, 134), "网页上下文 · 划词 · 引用 · 提示词库", font=sub_f, fill=(190, 205, 230))
draw_badge(d, (150, 178), "UNOFFICIAL", badge_f)
d.text((150, 214), "Microsoft Edge · Desktop", font=font(EN, 11), fill=(140, 160, 190))
small.convert("RGB").save(STORE / "small-promo-440x280.png")

# 3) Large promo tile 1400x560
large = icon_tile((1400, 560))
d = ImageDraw.Draw(large)
ic = icon.resize((190, 190), Image.LANCZOS)
large.alpha_composite(ic, (80, 130))
d.text((80, 350), "DeepSeek Sidebar+", font=font(EN_BOLD, 34), fill=(255, 255, 255))
d.text((80, 396), "网页上下文、划词、引用、提示词库，都在侧边栏。", font=font(CN_BOLD, 24), fill=(215, 225, 245))
d.text((80, 440), "An unofficial Edge sidebar for DeepSeek.", font=font(EN, 17), fill=(150, 170, 200))
d.text((80, 480), "非官方扩展 · 与 DeepSeek 官方无关联", font=font(CN, 14), fill=(130, 150, 180))
# right feature list
fx = 810
d.text((fx, 120), "FEATURES", font=font(EN_BOLD, 12), fill=(110, 140, 255))
features = [
    ("01", "读取当前网页", "Read page context"),
    ("02", "划词自动填入", "Selection autofill"),
    ("03", "引用对话", "Quote replies"),
    ("04", "提示词库", "Prompt library"),
]
for i, (num, zh, en) in enumerate(features):
    y = 160 + i * 78
    d.text((fx, y), num, font=font(EN_BOLD, 12), fill=(110, 140, 255))
    d.text((fx + 36, y - 4), zh, font=font(CN_BOLD, 19), fill=(235, 242, 255))
    d.text((fx + 36, y + 22), en, font=font(EN, 12), fill=(140, 160, 190))
large.convert("RGB").save(STORE / "large-promo-1400x560.png")

print("written", [p.name for p in STORE.glob("*.png")])
