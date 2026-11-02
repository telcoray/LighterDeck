"""Link preview card for one market (1200x630 PNG), in the Phosphor colours of the site's own card:
the market's name, price and 24h change on the left, its last 56 four-hour candles on the right.
Drawn at twice the size and scaled down, so lines and text come out smooth."""
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONTS = Path(__file__).resolve().parent / "fonts"  # Inter and JetBrains Mono, SIL Open Font License
S = 2
W, H = 1200, 630
BG = (10, 11, 13)
PANEL = (14, 16, 18)
TEXT = (216, 248, 235)
TEXT2 = (135, 232, 193)
MUTED = (77, 199, 150)
LINE = (27, 42, 36)
GRID = (22, 33, 28)
GREEN = (43, 217, 164)
RED = (242, 84, 109)


def _font(name, size):
    return ImageFont.truetype(str(FONTS / name), size * S)


def _fit(draw, text, name, size, max_width):
    """The largest size up to `size` at which `text` fits in max_width."""
    while size > 12 and draw.textlength(text, font=_font(name, size)) > max_width * S:
        size -= 2
    return _font(name, size)


def card(symbol, name, price, change_pct, bars, url):
    img = Image.new("RGB", (W * S, H * S), BG)
    d = ImageDraw.Draw(img)
    p = lambda x, y: (x * S, y * S)

    # logo and brand
    ox, oy, k = 72, 64, 0.8
    L = lambda x, y: p(ox + x * k, oy + y * k)
    d.line([L(16, 12), L(16, 50), L(50, 50)], fill=TEXT, width=round(7 * k * S), joint="curve")
    d.line([L(38, 13), L(38, 41)], fill=GREEN, width=round(2.4 * k * S))
    d.rounded_rectangle([L(33.5, 19), L(42.5, 35)], radius=2 * S, fill=GREEN)
    d.text(p(132, 70), "LighterDeck", font=_font("inter-700.ttf", 30), fill=TEXT)

    # market, price, change
    d.text(p(72, 170), symbol, font=_fit(d, symbol, "inter-700.ttf", 100, 470), fill=TEXT)
    if name and name != symbol:
        d.text(p(74, 292), name[:34], font=_fit(d, name[:34], "inter-600.ttf", 26, 470), fill=MUTED)
    if price:
        d.text(p(72, 360), price, font=_fit(d, price, "jetbrains-mono-500.ttf", 56, 470), fill=TEXT)
    if change_pct is not None:
        d.text(p(74, 436), f"{'+' if change_pct >= 0 else '−'}{abs(change_pct):.2f}%  24h",
               font=_font("jetbrains-mono-500.ttf", 28), fill=GREEN if change_pct >= 0 else RED)
    d.text(p(72, 552), url, font=_font("jetbrains-mono-500.ttf", 22), fill=MUTED)

    # chart
    fx0, fy0, fx1, fy1 = 600, 108, 1140, 566
    d.text(p(fx0, 70), f"{symbol} · 4h · Lighter", font=_font("jetbrains-mono-500.ttf", 18), fill=TEXT2)
    d.rounded_rectangle([p(fx0, fy0), p(fx1, fy1)], radius=12 * S, fill=PANEL, outline=LINE, width=2 * S)
    if len(bars) >= 2:
        cx0, cy0, cx1, cy1 = fx0 + 12, fy0 + 18, fx1 - 12, fy1 - 18
        lo, hi = min(b["low"] for b in bars), max(b["high"] for b in bars)
        pad = (hi - lo) * 0.06 or hi * 0.01 or 1
        lo, hi = lo - pad, hi + pad
        y = lambda v: cy1 - (v - lo) / (hi - lo) * (cy1 - cy0)
        for i in range(1, 4):
            gy = cy0 + (cy1 - cy0) * i / 4
            d.line([p(cx0, gy), p(cx1, gy)], fill=GRID, width=S)
        step = (cx1 - cx0) / len(bars)
        body = max(3.0, step * 0.62)
        for i, b in enumerate(bars):
            col = GREEN if b["close"] >= b["open"] else RED
            x = cx0 + i * step + step / 2
            d.line([p(x, y(b["high"])), p(x, y(b["low"]))], fill=col, width=max(2, round(1.4 * S)))
            top, bot = y(max(b["open"], b["close"])), y(min(b["open"], b["close"]))
            d.rectangle([p(x - body / 2, top), p(x + body / 2, max(bot, top + 1.5))], fill=col)
        last = y(bars[-1]["close"])
        for gx in range(int(cx0), int(cx1), 8):  # dashed last-price line
            d.line([p(gx, last), p(min(gx + 3, cx1), last)], fill=MUTED, width=S)

    out = BytesIO()
    img.resize((W, H), Image.LANCZOS).save(out, "PNG", optimize=True)
    return out.getvalue()
