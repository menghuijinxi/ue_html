"""Check frozen-scene screenshots after the browser measurements finish."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("diagnostic")
parser.add_argument("output")
args = parser.parse_args()
output = Path(args.output)
assert not output.exists(), "Use a fresh output"
report = json.loads(Path(args.diagnostic).read_text(encoding="utf-8-sig"))
assert report["pass"]
def pixels(artifact):
    assert hashlib.sha256(Path(artifact["file"]).read_bytes()).hexdigest() == artifact["sha256"]
    return np.array(Image.open(artifact["file"]).convert("RGB"), dtype=np.int16)


def difference(a, b):
    assert a.shape == b.shape
    mask = np.ones(a.shape[:2], dtype=bool)
    mask[:240, :270] = False
    delta = np.abs(a - b)[mask]
    return {"meanAbsoluteRGB": float(delta.mean()), "p99RGB": float(np.percentile(delta, 99)),
            "maxRGB": int(delta.max()), "fractionPixelsOver8": float(np.mean(delta.max(axis=1) > 8))}


comparisons = []
if "views" in report:
    for view, group in enumerate(report["views"]):
        assert len(group["images"]) == (3 if report.get("staging") else 7)
        for index in range(1, len(group["images"]), 2):
            before, actual, after = group["images"][index - 1:index + 2]
            assert before["mode"] == after["mode"] == "control"
            a, b, c = [pixels(item["screenshot"]) for item in (before, actual, after)]
            noise = difference(a, c)
            differences = [difference(a, b), difference(c, b)]
            row = {"mode": actual["mode"], "view": view,
                   "before": differences[0], "after": differences[1], "controlDrift": noise}
            closest = min(differences, key=lambda item: item["meanAbsoluteRGB"])
            row.update(closest)
            row["pass"] = (closest["meanAbsoluteRGB"] <= max(0.5, noise["meanAbsoluteRGB"] * 1.25)
                           and closest["fractionPixelsOver8"] <= max(0.01, noise["fractionPixelsOver8"] * 1.25))
            comparisons.append(row)
else:
    phases = {phase["mode"]: phase for phase in report["phases"]}
    for mode in ("binding", "tlv", "combined"):
        for index, view in enumerate(phases[mode]["views"]):
            row = {"mode": mode, "view": index,
                   **difference(pixels(phases["control"]["views"][index]["screenshot"]), pixels(view["screenshot"]))}
            row["pass"] = row["meanAbsoluteRGB"] < 1 and row["fractionPixelsOver8"] < 0.03
            comparisons.append(row)
result = {"pass": all(row["pass"] for row in comparisons), "comparisons": comparisons,
          "diagnostic": {"file": str(Path(args.diagnostic).resolve()),
                         "sha256": hashlib.sha256(Path(args.diagnostic).read_bytes()).hexdigest()},
          "source": {"file": str(Path(__file__).resolve()),
                     "sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
          "boundary": "Five frozen views; excludes the dynamic HUD rectangle. For bracketed captures, use the closer adjacent control and retain the before/after control drift. Acceptance bounds: mean RGB <= max(0.5, 1.25x control drift), fraction pixels >8 <= max(0.01, 1.25x control drift). Image smoke check supplements descriptor validation and actual volume hashes."}
output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"pass": result["pass"], "comparisons": len(comparisons),
                  "worstMeanAbsoluteRGB": max(row["meanAbsoluteRGB"] for row in comparisons)}))
assert result["pass"], "Inspect image differences"
