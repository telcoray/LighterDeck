"""Every offline test, one after the other: fakes instead of Lighter, nothing leaves this computer.

    python tests/run_offline.py
"""
import subprocess
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
failed = []
for test in sorted((here / "offline").glob("test_*.py")):
    r = subprocess.run([sys.executable, str(test)], capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = r.stdout + r.stderr
    bad = r.returncode != 0 or "FAIL" in out
    passed = out.count("PASS")
    print(f"{'FAIL' if bad else 'ok  '} {test.name}  ({passed} checks)")
    if bad:
        failed.append(test.name)
        print("\n".join("     " + line for line in out.splitlines() if "PASS" not in line))
print("ALL PASS" if not failed else f"{len(failed)} FAILED: {', '.join(failed)}")
sys.exit(1 if failed else 0)
