"""Link preview cards (1200x630 PNG) in the Ambra colours: the site's own card (tools/make_og.py writes it to
frontend/og.png) and one per market (/og/WTI.png): name, price and 24h change on the left, its last 56
four-hour candles on the right. Drawn at twice the size and scaled down, so lines and text come out smooth."""
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONTS = Path(__file__).resolve().parent / "fonts"  # Inter and JetBrains Mono, SIL Open Font License
S = 2
W, H = 1200, 630
BG = (0, 0, 0)
PANEL = (11, 11, 11)
TEXT = (244, 244, 244)
ORANGE = (255, 160, 40)
MUTED = (224, 138, 31)
LINE = (44, 44, 44)
GRID = (24, 24, 24)
GREEN = (61, 220, 74)
RED = (255, 59, 59)
LOGO = (43, 217, 164)  # the logo's own green, as in frontend/logo.svg

# what sets LighterDeck apart, for the site's card
STRENGTHS = [
    "Trailing stops & breakeven",
    "Orders and SL/TP from the chart",
    "Pair trading on spreads",
    "Event trades from the calendar",
    "Paper trading on live prices",
]


def _font(name, size):
    return ImageFont.truetype(str(FONTS / name), size * S)


def _fit(draw, text, name, size, max_width):
    """The largest size up to `size` at which `text` fits in max_width."""
    while size > 12 and draw.textlength(text, font=_font(name, size)) > max_width * S:
        size -= 2
    return _font(name, size)


def _p(x, y):
    return x * S, y * S


def _brand(d, size=34):
    ox, oy, k = 72, 60, 0.85
    L = lambda x, y: _p(ox + x * k, oy + y * k)
    d.line([L(16, 12), L(16, 50), L(50, 50)], fill=TEXT, width=round(7 * k * S), joint="curve")
    d.line([L(38, 13), L(38, 41)], fill=LOGO, width=round(2.4 * k * S))
    d.rounded_rectangle([L(33.5, 19), L(42.5, 35)], radius=2 * S, fill=LOGO)
    d.text(_p(136, 66), "LighterDeck", font=_font("inter-700.ttf", size), fill=TEXT)


def _chart(d, symbol, bars, right_label=""):
    fx0, fy0, fx1, fy1 = 600, 112, 1140, 566
    tag = _font("jetbrains-mono-500.ttf", 24)
    d.text(_p(fx0, 66), f"{symbol} · 4h · Lighter", font=tag, fill=MUTED)
    if right_label:
        d.text(_p(fx1, 66), right_label, font=tag, fill=TEXT, anchor="ra")
    d.rounded_rectangle([_p(fx0, fy0), _p(fx1, fy1)], radius=12 * S, fill=PANEL, outline=LINE, width=2 * S)
    if len(bars) < 2:
        return
    cx0, cy0, cx1, cy1 = fx0 + 12, fy0 + 18, fx1 - 12, fy1 - 18
    lo, hi = min(b["low"] for b in bars), max(b["high"] for b in bars)
    pad = (hi - lo) * 0.06 or hi * 0.01 or 1
    lo, hi = lo - pad, hi + pad
    y = lambda v: cy1 - (v - lo) / (hi - lo) * (cy1 - cy0)
    for i in range(1, 4):
        gy = cy0 + (cy1 - cy0) * i / 4
        d.line([_p(cx0, gy), _p(cx1, gy)], fill=GRID, width=S)
    step = (cx1 - cx0) / len(bars)
    body = max(3.0, step * 0.62)
    for i, b in enumerate(bars):
        col = GREEN if b["close"] >= b["open"] else RED
        x = cx0 + i * step + step / 2
        d.line([_p(x, y(b["high"])), _p(x, y(b["low"]))], fill=col, width=max(2, round(1.4 * S)))
        top, bot = y(max(b["open"], b["close"])), y(min(b["open"], b["close"]))
        d.rectangle([_p(x - body / 2, top), _p(x + body / 2, max(bot, top + 1.5))], fill=col)
    last = y(bars[-1]["close"])
    for gx in range(int(cx0), int(cx1), 8):  # dashed last-price line
        d.line([_p(gx, last), _p(min(gx + 3, cx1), last)], fill=MUTED, width=S)


def _png(img):
    out = BytesIO()
    img.resize((W, H), Image.LANCZOS).save(out, "PNG", optimize=True)
    return out.getvalue()


def card(symbol, name, price, change_pct, bars, url):
    """One market's card."""
    img = Image.new("RGB", (W * S, H * S), BG)
    d = ImageDraw.Draw(img)
    _brand(d)
    d.text(_p(72, 160), symbol, font=_fit(d, symbol, "inter-700.ttf", 104, 470), fill=TEXT)
    if name and name != symbol:
        d.text(_p(74, 290), name[:34], font=_fit(d, name[:34], "inter-600.ttf", 32, 470), fill=MUTED)
    if price:
        d.text(_p(72, 352), price, font=_fit(d, price, "jetbrains-mono-500.ttf", 64, 470), fill=TEXT)
    if change_pct is not None:
        d.text(_p(74, 438), f"{'+' if change_pct >= 0 else '−'}{abs(change_pct):.2f}%  24h",
               font=_font("jetbrains-mono-500.ttf", 34), fill=GREEN if change_pct >= 0 else RED)
    d.text(_p(72, 540), url, font=_fit(d, url, "jetbrains-mono-500.ttf", 30, 480), fill=ORANGE)
    _chart(d, symbol, bars)
    return _png(img)


def site_card(bars, last_label):
    """The site's card: what LighterDeck does best, next to a live BTC chart."""
    img = Image.new("RGB", (W * S, H * S), BG)
    d = ImageDraw.Draw(img)
    _brand(d)
    head = _font("inter-700.ttf", 44)
    d.text(_p(72, 148), "A pro trading terminal", font=_fit(d, "A pro trading terminal", "inter-700.ttf", 44, 490), fill=TEXT)
    x = 72 * S
    for part, col in (("for ", TEXT), ("Lighter", ORANGE), (" perpetuals", TEXT)):
        d.text((x, 202 * S), part, font=head, fill=col)
        x += d.textlength(part, font=head)
    item = _font("inter-600.ttf", 25)
    for i, text in enumerate(STRENGTHS):
        yy = 286 + i * 46
        d.rectangle([_p(74, yy + 10), _p(84, yy + 20)], fill=ORANGE)
        d.text(_p(100, yy), text, font=item, fill=TEXT)
    d.text(_p(72, 540), "lighterdeck.xyz", font=_font("jetbrains-mono-500.ttf", 30), fill=ORANGE)
    _chart(d, "BTC", bars, last_label)
    return _png(img)
