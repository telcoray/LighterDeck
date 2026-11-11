"""The site's link preview card (frontend/og.png, 1200x630): the logo and the name on the Ice theme's ground.

Drawn by backend/og.py, the same code and colours as each market's card:
  python tools/make_og.py
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))
import og  # noqa: E402

out = ROOT / "frontend" / "og.png"
out.write_bytes(og.site_card())
print("ok ->", out)
