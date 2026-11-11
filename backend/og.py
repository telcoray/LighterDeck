"""Link preview cards (1200x630 PNG) in the Ice colours, kept minimal: the site's own card (tools/make_og.py
writes it to frontend/og.png) is the logo and the name on a dark blue ground; a market's card (/og/WTI.png) is
its name, price and 24h change over one clean line of its last 56 four-hour closes. Drawn at twice the size and
scaled down, so lines and text come out smooth."""
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = Path(__file__).resolve().parent / "fonts"  # Inter and JetBrains Mono, SIL Open Font License
S = 2
W, H = 1200, 630
# the Ice theme (frontend/style.css, data-theme="ghiaccio")
BG = (7, 9, 12)
GLOW = (60, 98, 150)
TEXT = (235, 242, 251)
TEXT2 = (188, 211, 239)
MUTED = (142, 171, 208)
FAINT = (88, 111, 141)
GREEN = (43, 217, 164)
RED = (242, 84, 109)
LOGO_BAR = (228, 230, 234)  # the logo's own colours, as in frontend/logo.svg
LOGO = (43, 217, 164)


def _font(name, size):
    return ImageFont.truetype(str(FONTS / name), size * S)


def _fit(draw, text, name, size, max_width):
    """The largest size up to `size` at which `text` fits in max_width."""
    while size > 12 and draw.textlength(text, font=_font(name, size)) > max_width * S:
        size -= 2
    return _font(name, size)


def _p(x, y):
    return x * S, y * S


def _ground(glow_at=None, glow_r=360, strength=0.55):
    """The dark blue ground, with a soft light behind what matters."""
    img = Image.new("RGB", (W * S, H * S), BG)
    if glow_at:
        light = Image.new("L", img.size, 0)
        gx, gy = glow_at
        ImageDraw.Draw(light).ellipse([_p(gx - glow_r, gy - glow_r * 0.62), _p(gx + glow_r, gy + glow_r * 0.62)], fill=round(255 * strength))
        light = light.filter(ImageFilter.GaussianBlur(glow_r * S * 0.42))
        img = Image.composite(Image.new("RGB", img.size, GLOW), img, light)
    return img


def _logo(d, ox, oy, k):
    """The logo (frontend/logo.svg, a 64-unit square) with its top left at ox, oy, k pixels per unit."""
    L = lambda x, y: _p(ox + x * k, oy + y * k)
    d.line([L(16, 12), L(16, 50), L(50, 50)], fill=LOGO_BAR, width=round(7 * k * S), joint="curve")
    d.line([L(38, 13), L(38, 41)], fill=LOGO, width=round(2.4 * k * S))
    d.rounded_rectangle([L(33.5, 19), L(42.5, 35)], radius=round(1.6 * k * S), fill=LOGO)


def _png(img):
    out = BytesIO()
    img.resize((W, H), Image.LANCZOS).save(out, "PNG", optimize=True)
    return out.getvalue()


def _line(img, closes, box, colour):
    """One clean line of the closes, with a light fill under it fading to the ground."""
    x0, y0, x1, y1 = box
    lo, hi = min(closes), max(closes)
    pad = (hi - lo) * 0.08 or hi * 0.01 or 1
    lo, hi = lo - pad, hi + pad
    pts = [_p(x0 + (x1 - x0) * i / (len(closes) - 1), y1 - (v - lo) / (hi - lo) * (y1 - y0)) for i, v in enumerate(closes)]
    # the fill: the shape under the line, faded from top to bottom
    shape = Image.new("L", img.size, 0)
    ImageDraw.Draw(shape).polygon(pts + [_p(x1, y1), _p(x0, y1)], fill=255)
    fade = Image.linear_gradient("L").resize(img.size).point(lambda v: round((255 - v) * 0.22))
    fade.paste(0, mask=Image.eval(shape, lambda v: 255 - v))
    img.paste(Image.new("RGB", img.size, colour), mask=fade)
    d = ImageDraw.Draw(img)
    d.line(pts, fill=colour, width=round(3.2 * S), joint="curve")
    lx, ly = pts[-1]
    r = 7 * S
    d.ellipse([lx - r, ly - r, lx + r, ly + r], fill=colour)
    return d


def card(symbol, name, price, change_pct, bars, url):
    """One market's card: what it is and where it is, and which way it has been going."""
    up = change_pct is None or change_pct >= 0
    img = _ground((300, 250), 420, 0.35)
    closes = [b["close"] for b in bars]
    d = ImageDraw.Draw(img)
    if len(closes) >= 2:
        d = _line(img, closes, (72, 330, 1128, 560), GREEN if up else RED)
    _logo(d, 66, 50, 0.72)
    d.text(_p(122, 60), "LighterDeck", font=_font("inter-600.ttf", 26), fill=TEXT2)
    d.text(_p(1128, 64), url, font=_fit(d, url, "jetbrains-mono-500.ttf", 22, 520), fill=FAINT, anchor="ra")
    d.text(_p(70, 120), symbol, font=_fit(d, symbol, "inter-700.ttf", 96, 640), fill=TEXT)
    sub = name if name and name != symbol else ""
    if price:
        pf = _fit(d, price, "jetbrains-mono-500.ttf", 52, 560)
        d.text(_p(72, 238), price, font=pf, fill=TEXT)
        if change_pct is not None:
            px = 72 + d.textlength(price, font=pf) / S + 26
            d.text(_p(px, 252), f"{'+' if change_pct >= 0 else '−'}{abs(change_pct):.2f}%  24h",
                   font=_font("jetbrains-mono-500.ttf", 32), fill=GREEN if change_pct >= 0 else RED)
    if sub:
        d.text(_p(1128, 140), sub[:30], font=_fit(d, sub[:30], "inter-600.ttf", 30, 420), fill=MUTED, anchor="ra")
    return _png(img)


def site_card(bars=None, last_label=""):
    """The site's card: the logo and the name, nothing else."""
    img = _ground((600, 270), 380, 0.6)
    d = ImageDraw.Draw(img)
    k = 4.2  # 64 units -> about 270 px
    _logo(d, 600 - 33 * k, 270 - 31 * k, k)
    name = _font("inter-700.ttf", 64)
    d.text(_p(600, 470), "LighterDeck", font=name, fill=TEXT, anchor="mm")
    d.text(_p(600, 534), "A trading terminal for Lighter", font=_font("inter-600.ttf", 28), fill=MUTED, anchor="mm")
    return _png(img)
