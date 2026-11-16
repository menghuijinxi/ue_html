"""Run the unchanged local UE59 pack builder on this diagnostic's captures."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument("--suite", required=True)
args = parser.parse_args()
project = Path(__file__).resolve().parents[3]
suite = Path(args.suite).resolve()


def check_output(target):
    subprocess.run(["node", str(project / "tests/web-platform/project-output.cjs"),
                    "--check", str(target)], check=True)
    return target


check_output(suite)
metadata = json.loads((suite / "suite.json").read_text(encoding="utf-8"))
spec = importlib.util.spec_from_file_location("ue59_prewarm_pack", metadata["packer"]["file"])
official = importlib.util.module_from_spec(spec)
spec.loader.exec_module(official)
captures = [json.loads((suite / f"capture-{index}.json").read_text(encoding="utf-8"))
            for index in range(2)]
for capture in captures:
    assert capture["stamp"] == metadata["stamp"]
    assert capture["marks"]["engine_page"] is True
    assert not any(call.get("error") for call in capture["calls"])
pack, report = official.build(captures, metadata["stamp"], after_ready=8.0,
                              in_flight=16, module_kb_per_frame=128)
assert not report["missing_refs"]
assert not report["pipelines_dropped_by_cap"]
pack["diagnosticBinding"] = metadata["binding"]
for name, data in [("ue59-pack.json", pack), ("pack-report.json", report)]:
    check_output(suite / name).write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
print(json.dumps(report))
