"""Link preview card (1200x630) for lighterdeck.xyz: Phosphor colours, real BTC 4h candles from Lighter.

Writes an HTML card; render it to frontend/og.png with a headless browser, e.g.
  python tools/make_og.py card.html
  msedge --headless=new --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630
         --virtual-time-budget=5000 --screenshot=frontend/og.png file:///.../card.html
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

out = Path(sys.argv[1])
now = int(time.time())
url = (f"https://mainnet.zklighter.elliot.ai/api/v1/candles?market_id=1&resolution=4h"
       f"&start_timestamp={now - 4 * 3600 * 70}&end_timestamp={now}&count_back=70")
rows = json.load(urllib.request.urlopen(url, timeout=20))["c"][-56:]
bars = [(float(c["o"]), float(c["h"]), float(c["l"]), float(c["c"])) for c in rows]

W, H = 560, 410          # chart area
lo, hi = min(b[2] for b in bars), max(b[1] for b in bars)
pad = (hi - lo) * 0.08
lo, hi = lo - pad, hi + pad
y = lambda p: H - (p - lo) / (hi - lo) * H
step = W / len(bars)
body = max(3.0, step * 0.62)
svg = []
for i in range(5):  # faint grid
    gy = H * i / 4
    svg.append(f'<line x1="0" x2="{W}" y1="{gy:.1f}" y2="{gy:.1f}" stroke="#16211c" stroke-width="1"/>')
for i, (o, h, l, c) in enumerate(bars):
    x = i * step + step / 2
    col = "#2bd9a4" if c >= o else "#f2546d"
    top, bot = y(max(o, c)), y(min(o, c))
    svg.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{y(h):.1f}" y2="{y(l):.1f}" stroke="{col}" stroke-width="1.4"/>')
    svg.append(f'<rect x="{x - body / 2:.1f}" y="{top:.1f}" width="{body:.1f}" height="{max(1.5, bot - top):.1f}" fill="{col}"/>')
last = bars[-1][3]
svg.append(f'<line x1="0" x2="{W}" y1="{y(last):.1f}" y2="{y(last):.1f}" stroke="#2bd9a4" stroke-width="1" stroke-dasharray="3 4" opacity=".7"/>')
chart = f'<svg width="{W}" height="{H}" viewBox="0 0 {W} {H}">{"".join(svg)}</svg>'

html = f"""<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=block" rel="stylesheet">
<style>
  html, body {{ margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #0a0b0d; }}
  .card {{ position: relative; width: 1200px; height: 630px; display: flex; font-family: Inter, sans-serif; color: #d8f8eb;
          background: radial-gradient(900px 500px at 85% 40%, rgba(43,217,164,.07), transparent 70%), #0a0b0d; }}
  .left {{ width: 560px; padding: 70px 0 0 72px; display: flex; flex-direction: column; }}
  .brand {{ display: flex; align-items: center; gap: 18px; }}
  .brand span {{ font-size: 50px; font-weight: 700; letter-spacing: -.02em; }}
  h1 {{ margin: 44px 0 0; font-size: 44px; line-height: 1.12; font-weight: 600; letter-spacing: -.02em; color: #d8f8eb; }}
  h1 em {{ font-style: normal; color: #2bd9a4; }}
  .feat {{ margin-top: 30px; display: flex; flex-wrap: wrap; gap: 10px; }}
  .feat b {{ font: 500 17px "JetBrains Mono", monospace; color: #87e8c1; border: 1.5px solid #294c3e; border-radius: 8px; padding: 7px 13px; }}
  .url {{ position: absolute; left: 72px; bottom: 54px; font: 500 22px "JetBrains Mono", monospace; color: #4dc796; }}
  .right {{ position: absolute; right: 56px; top: 70px; width: 560px; }}
  .tag {{ display: flex; justify-content: space-between; font: 500 18px "JetBrains Mono", monospace; color: #87e8c1; margin-bottom: 14px; }}
  .tag i {{ font-style: normal; color: #2bd9a4; }}
  .frame {{ border: 1.5px solid #1b2a24; border-radius: 12px; padding: 14px 0 10px; background: rgba(14,15,18,.6); }}
</style></head><body><div class="card">
  <div class="left">
    <div class="brand">
      <svg width="64" height="64" viewBox="0 0 64 64"><path d="M16 12V50H50" fill="none" stroke="#d8f8eb" stroke-width="7" stroke-linecap="square"/>
        <path d="M38 13V41" stroke="#2bd9a4" stroke-width="2.4" stroke-linecap="round"/><rect x="33.5" y="19" width="9" height="16" rx="1.6" fill="#2bd9a4"/></svg>
      <span>LighterDeck</span>
    </div>
    <h1>A trading terminal for <em>Lighter</em> perpetuals</h1>
    <div class="feat"><b>4 charts</b><b>calendar per market</b><b>funding</b></div>
  </div>
  <div class="right">
    <div class="tag"><span>BTC · 4h · Lighter</span><i>{last:,.0f}</i></div>
    <div class="frame">{chart}</div>
  </div>
  <div class="url">lighterdeck.xyz</div>
</div></body></html>"""
out.write_text(html, encoding="utf-8")
print("ok", len(bars), "bars, last", last)
