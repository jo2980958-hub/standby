"""One live Nemotron run per example household, saved to cache/. Run rarely."""
import json, sys
from pathlib import Path
from engine import build_facts
from agent import run, merge
from households import EXAMPLES

for h in EXAMPLES:
    f = build_facts(h)
    out = run(f)
    print(h["id"], json.dumps(out)[:300])
    (Path(__file__).parent / "cache" / f"{h['id']}.json").write_text(json.dumps(dict(raw=out, pack=merge(f, out)), indent=1))
