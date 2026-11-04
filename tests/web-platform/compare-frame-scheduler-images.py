"""Compare independent scheduler runs against their bracketed control images."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("capture")
parser.add_argument("output")
args = parser.parse_args()
output = Path(args.output)
assert not output.exists(), "Use a fresh output"
capture = json.loads(Path(args.capture).read_text(encoding="utf-8-sig"))
assert capture["pass"] and capture["stress"]
before, candidate, after = capture["runs"]
assert before["mode"] == after["mode"] == "control"
assert len(before["visual"]) == len(candidate["visual"]) == len(after["visual"]) == 5


def pixels(artifact):
    assert hashlib.sha256(Path(artifact["file"]).read_bytes()).hexdigest() == artifact["sha256"]
    return np.asarray(Image.open(artifact["file"]).convert("RGB"), dtype=np.int16)


def difference(a, b):
    assert a.shape == b.shape
    mask = np.ones(a.shape[:2], dtype=bool)
    mask[:240, :270] = False
    delta = np.abs(a - b)[mask]
    return {"meanAbsoluteRGB": float(delta.mean()),
            "fractionPixelsOver8": float(np.mean(delta.max(axis=1) > 8))}


comparisons = []
for index in range(5):
    entries = [run["visual"][index] for run in (before, candidate, after)]
    assert entries[0]["view"] == entries[1]["view"] == entries[2]["view"]
    assert entries[0]["snapshot"]["camera"] == entries[1]["snapshot"]["camera"] == entries[2]["snapshot"]["camera"]
    assert all(entry["snapshot"]["streaming"]["pending"] == 0 for entry in entries)
    a, b, c = [pixels(entry["screenshot"]) for entry in entries]
    drift = difference(a, c)
    diffs = [difference(a, b), difference(c, b)]
    closest = min(diffs, key=lambda item: item["meanAbsoluteRGB"])
    comparisons.append({"view": index, "before": diffs[0], "after": diffs[1], "controlDrift": drift,
                        "residentBytes": [entry["snapshot"]["streaming"]["residentBytes"] for entry in entries],
                        **closest,
                        "pass": closest["meanAbsoluteRGB"] <= max(0.5, drift["meanAbsoluteRGB"] * 1.25)
                        and closest["fractionPixelsOver8"] <= max(0.01, drift["fractionPixelsOver8"] * 1.25)})


def audit(file):
    return {"file": str(Path(file).resolve()), "sha256": hashlib.sha256(Path(file).read_bytes()).hexdigest()}


report = {"pass": all(row["pass"] for row in comparisons), "comparisons": comparisons,
          "source": audit(__file__), "diagnostic": audit(args.capture),
          "boundary": "Five independent-session views bracketed by controls. Dynamic HUD excluded. "
          "Existing temporal-drift thresholds: mean RGB <= max(0.5, 1.25 * control drift), "
          "fraction pixels >8 <= max(1%, 1.25 * control drift). This is not bitwise parity or a motion artifact test."}
output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"pass": report["pass"], "views": len(comparisons),
                  "worstMeanAbsoluteRGB": max(row["meanAbsoluteRGB"] for row in comparisons)}))
assert report["pass"], "Inspect image differences"
