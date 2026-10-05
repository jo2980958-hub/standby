"""Nemotron turns the computed readiness facts into the requirements pack:
what each item needs before the power goes, the gap, the actions, and the
devices a household has left off its list. Status and every number are fixed
by engine.py; the model writes words around them and may add missing items."""
from __future__ import annotations

import json
import re

from nemotron import SUPER, think

SYSTEM = """You write the readiness pack for a household that depends on electricity at home.
You get JSON facts: each person's devices with a computed status (ready, short, gap, check),
hours of backup, and the longest outage this county actually had. Rules:
- Never change a status or a number. Never write any number, duration, quantity or percentage that does not appear in the facts: no minutes, no "24 hours of ice", no "twice daily". Use words ("fully charged", "enough") instead.
- Describe each item from its "setup" and "facts" exactly (if one external battery is listed, there is one). Status "check" means the figure is unknown, not zero: say to confirm it, never that there is no backup.
- Say "planned backup" for backup_planned_hours. The outage record is hours with a tenth or more of the county's customers out, not a total blackout.
- Every listed item must appear in items, including ones that are already ready or have no battery.
- Plain, short, second-person. No filler, no warnings about consulting professionals.
- requirement: what the item must have in place before the power goes (max 22 words).
- gap: why it falls short against the outage record, empty string if status is ready (max 22 words).
- actions: 1 to 3 concrete steps, each max 14 words, starting with a verb.
- If the facts say "not recorded" or "not in our sources", tell the person to check the product label or ask the supplier; do not guess hours.
- missing: up to 3 things this household needs but did not list (for example a person on oxygen with no backup oxygen supply, or a powered place to go). Each must be a device or place NOT already listed. Each: device, why (max 18 words), action (max 14 words). Empty list if nothing is missing.
- priority: the 3 to 5 most urgent steps across the household, most urgent first, each {item_id, text} with text max 16 words. item_id is an item id or "household".
- headline: one sentence, max 16 words, the household's position against the outage record.
- decision: one or two sentences, max 40 words: stay, or leave for a powered place before the storm arrives, and why, using the backup hours versus the outage hours.
Return only JSON: {"headline":str,"decision":str,"items":[{"id":str,"requirement":str,"gap":str,"actions":[str]}],"missing":[{"device":str,"why":str,"action":str}],"priority":[{"item_id":str,"text":str}]}"""


def compact(facts: dict) -> dict:
    return dict(
        place=facts["household"]["place_label"],
        outage_record=dict(event=facts["event"]["name"], hours_with_10pct_or_more_of_county_dark=facts["event"]["hours_over_10pct"],
                           peak_pct_out=facts["event"]["peak_pct"], pct_still_out_72h_after_peak=facts["event"]["pct_72h"],
                           harm=facts["event"]["harm"]),
        medicare_beneficiaries_on_power_dependent_equipment=facts["empower"].get("power"),
        planning_rule=f"planned backup is {int(facts['plan_fraction']*100)}% of the manual's best or typical figure",
        people=[dict(name=p["name"], items=[dict(
            id=i["id"], device=i["label"], role=i["role"], setup=i["option_label"], status=i["status"],
            backup_best_hours=i["best_h"], backup_planned_hours=i["plan_h"], cover=i["cover"], facts=i["facts"],
            covered_by_outdoor_generator=i["via_generator"]) for i in p["items"]]) for p in facts["people"]])


NUM = re.compile(r"\d+(?:\.\d+)?")


def clean(x):
    if isinstance(x, str):
        return (x.replace("\u2011", "-").replace("\u202f", " ").replace("\u2019", "'")
                .replace("\u2013", "-").replace("\u2014", ", ").strip())
    if isinstance(x, list):
        return [clean(v) for v in x]
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    return x


def problems(facts: dict, out: dict) -> list[str]:
    """Things a reader would be misled by: numbers the facts do not hold, and listed items with no text."""
    allowed = set(NUM.findall(json.dumps(compact(facts))))
    bad, texts = [], []
    for it in out.get("items", []):
        texts += [it.get("requirement", ""), it.get("gap", "")] + list(it.get("actions") or [])
    for m in out.get("missing", []):
        texts += [m.get("why", ""), m.get("action", "")]
    texts += [out.get("headline", ""), out.get("decision", "")] + [x.get("text", "") for x in out.get("priority", [])]
    for t in texts:
        for n in NUM.findall(str(t)):
            if n not in allowed:
                bad.append(f"number {n} in: {t}")
    ext = [i["opts"].get("external") for p in facts["people"] for i in p["items"] if i["device"] == "astral"]
    if ext and "2" not in ext:
        for t in texts:
            if re.search(r"\b(both|two|each) external", str(t), re.I):
                bad.append(f"only {ext[0]} external battery is listed, not two: {t}")
    if any(i["status"] == "check" for p in facts["people"] for i in p["items"]):
        for t in (out.get("headline", ""), out.get("decision", "")):
            if re.search(r"\b(neither|no backup|zero backup)\b", str(t), re.I):
                bad.append(f"an item has status check (unknown backup), so do not say it has none: {t}")
    have = {i.get("id") for i in out.get("items", [])}
    for p in facts["people"]:
        for i in p["items"]:
            if i["id"] not in have:
                bad.append(f"no entry for item {i['id']}")
    return bad


def run(facts: dict, model: str = SUPER) -> dict:
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": json.dumps(compact(facts))}]
    out = {}
    for attempt in range(3):
        out = clean(think(msgs, model=model, json_out=True, reasoning_effort="low", max_tokens=6000, temperature=0.2))
        bad = problems(facts, out)
        if not bad:
            return out
        msgs = msgs[:2] + [{"role": "assistant", "content": json.dumps(out)},
                           {"role": "user", "content": "Fix these and return the full JSON again:\n" + "\n".join(bad[:8])}]
    return out


def merge(facts: dict, out: dict) -> dict:
    """Join model text onto computed facts. Unknown ids are dropped; items the model
    skipped keep their computed facts and get no invented text."""
    by_id = {i["id"]: i for i in out.get("items", []) if isinstance(i, dict)}
    for p in facts["people"]:
        for it in p["items"]:
            t = by_id.get(it["id"], {})
            it["requirement"] = str(t.get("requirement", "")).strip()
            it["gap"] = str(t.get("gap", "")).strip() if it["status"] != "ready" else ""
            it["actions"] = [str(a).strip() for a in (t.get("actions") or [])][:3]
    valid = {i["id"] for p in facts["people"] for i in p["items"]} | {"household"}
    pr = []
    for x in out.get("priority", []):
        if isinstance(x, dict) and x.get("item_id") in valid and x.get("text"):
            pr.append(dict(item_id=x["item_id"], text=str(x["text"]).strip()))
    miss = []
    for m in out.get("missing", [])[:3]:
        if isinstance(m, dict) and m.get("device") and m.get("why"):
            miss.append(dict(device=str(m["device"]).strip(), why=str(m["why"]).strip(),
                             action=str(m.get("action", "")).strip()))
    facts["headline"] = str(out.get("headline", "")).strip()
    facts["decision"] = str(out.get("decision", "")).strip()
    facts["priority"] = pr[:5]
    facts["missing"] = miss
    return facts
