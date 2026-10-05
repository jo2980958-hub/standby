"""Readiness engine. Device runtimes come from the manufacturers' manuals saved in
research/data/devices; outage durations come from the EAGLE-I county record
(data/events.json). Status is computed here, never by the model."""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVENTS = json.loads((HERE / "data" / "events.json").read_text())
EMPOWER = json.loads((HERE / "data" / "empower.json").read_text())

PLAN_FRACTION = 0.5  # plan on half of a manual's typical or best-case figure

HARM = {
    "irma": "16 carbon monoxide deaths after Irma; 3 oxygen-dependent patients and 17 heat deaths tied to power loss (CDC MMWR 2018).",
    "uri": "25 deaths from interrupted dialysis or oxygen, frozen devices and medication, or power loss on life-sustaining equipment; 19 carbon monoxide deaths (Texas DSHS, Dec 2021).",
    "beryl": "Six of 13 Harris County storm deaths were heat exposure tied to the outage (Harris County IFS, early count reported 18 Jul 2024).",
}

PLACES = {
    "broward": dict(label="Broward County, FL", event="irma", fips="12011"),
    "travis": dict(label="Travis County, TX", event="uri", fips="48453"),
    "harris": dict(label="Harris County, TX", event="beryl", fips="48201"),
}

CATALOGUE = {
    "inogen_g5": dict(
        label="Inogen One G5", role="Portable oxygen concentrator", kind="oxygen",
        option=dict(key="batteries", label="Batteries", choices=[["1", "1 battery"], ["2", "2 batteries"]]),
        source="Inogen One G5 user manual, rev C"),
    "stationary_o2": dict(
        label="Home oxygen concentrator", role="Stationary oxygen concentrator", kind="oxygen",
        option=dict(key="backup", label="Backup oxygen", choices=[["none", "No cylinders"], ["cylinders", "Cylinders on hand"]]),
        source="No wattage or runtime in the sources we hold"),
    "astral": dict(
        label="ResMed Astral", role="Home ventilator", kind="vent",
        option=dict(key="external", label="External batteries", choices=[["0", "None"], ["1", "1"], ["2", "2"]]),
        source="ResMed Astral 100/150 user guide"),
    "airsense": dict(
        label="ResMed AirSense 11", role="CPAP", kind="sleep",
        option=dict(key="battery", label="Power", choices=[["none", "Mains only"], ["converter", "DC converter and deep-cycle battery"]]),
        source="ResMed Air11 DC-DC converter user guide"),
    "insulin": dict(
        label="Insulin", role="Refrigerated medication", kind="cold",
        option=dict(key="cold", label="Cold storage", choices=[["fridge", "Fridge only"], ["cooler", "Cooler and ice packs"]]),
        source="Storage limits are on the product label, not in the sources we hold"),
    "generator": dict(
        label="Portable generator", role="Backup power", kind="power",
        option=dict(key="where", label="Runs", choices=[["outdoors", "Outdoors"], ["garage", "In the garage"]]),
        source="CDC MMWR 2018; Texas DSHS 2021"),
}


def catalogue_public():
    return [dict(id=k, **{x: v[x] for x in ("label", "role", "kind", "option")}) for k, v in CATALOGUE.items()]


def _h(x: float) -> str:
    return f"{x:g} h"


def device_cover(dev: str, opts: dict):
    """-> (best_h or None, plan_h or None, cover text, facts[])"""
    if dev == "inogen_g5":
        n = int(opts.get("batteries", 1))
        best = 6.5 * n
        return best, best * PLAN_FRACTION, f"Up to {_h(best)} at flow setting 1", [
            f"{'Double' if n == 2 else 'Single'} battery: up to {_h(best)} (manual); runtime falls at higher flow settings.",
            f"Recharge takes up to {'6' if n == 2 else '3'} h on mains.",
            "Car DC input 13.5-15.0 V, 10 A max.",
        ]
    if dev == "astral":
        n = int(opts.get("external", 0))
        best = 8 * (1 + n)
        return best, best * PLAN_FRACTION, f"About {_h(best)} typical use", [
            "Internal battery about 8 h typical, over 4 h worst case.",
            f"{n} external battery(ies): 8 h each in typical use, two at most." if n else "No external battery connected.",
        ]
    if dev == "stationary_o2":
        if opts.get("backup") == "cylinders":
            return None, None, "Depends on cylinder size and flow rate", ["No battery. Cylinder hours are not in our sources."]
        return 0, 0, "None", ["Mains only; stops when the power stops."]
    if dev == "airsense":
        if opts.get("battery") == "converter":
            return None, None, "Depends on the battery's capacity", [
                "Converter input 12 V or 24 V; output 24 V, 3.75 A.",
                "A vehicle battery may not keep enough reserve to start the vehicle."]
        return 0, 0, "None", ["No internal battery; stops when the power stops."]
    if dev == "insulin":
        if opts.get("cold") == "cooler":
            return None, None, "Depends on the label's storage limit", ["Check the storage limit printed on the product."]
        return 0, 0, "None", ["Fridge only; warms when the power stops."]
    if dev == "generator":
        if opts.get("where") == "garage":
            return 0, 0, "Unsafe where it runs", ["Exhaust carbon monoxide builds up in enclosed spaces, a garage included."]
        return None, None, "Depends on fuel on hand", ["Outdoors only, away from doors and windows."]
    raise KeyError(dev)


def build_facts(household: dict) -> dict:
    place = PLACES[household["place"]]
    ev = EVENTS[place["event"]]
    need = ev["hours_over_10pct"]
    gen_ok = any(d["device"] == "generator" and d.get("opts", {}).get("where") == "outdoors"
                 for p in household["people"] for d in p["devices"])
    people = []
    for pi, person in enumerate(household["people"]):
        items = []
        for di, d in enumerate(person["devices"]):
            spec = CATALOGUE[d["device"]]
            best, plan, cover, facts = device_cover(d["device"], d.get("opts", {}))
            kind = d["device"]
            if kind == "generator":
                status = "gap" if cover == "Unsafe where it runs" else "check"
            elif plan is None:
                status = "check"
            elif plan >= need:
                status = "ready"
            elif plan > 0:
                status = "short"
            else:
                status = "gap"
            viaGen = False
            if gen_ok and kind not in ("generator", "insulin") and status in ("gap", "short"):
                status, viaGen = "check", True
                cover = (cover + "; " if plan else "") + "generator, fuel hours not recorded"
            items.append(dict(
                id=f"p{pi}d{di}", device=d["device"], label=spec["label"], role=spec["role"], kind=spec["kind"],
                opts=d.get("opts", {}),
                option_label=next((c[1] for c in spec["option"]["choices"] if c[0] == str(d.get("opts", {}).get(spec["option"]["key"]))), ""),
                status=status, best_h=best, plan_h=plan, need_h=need, cover=cover, facts=facts,
                via_generator=viaGen, source=spec["source"]))
        people.append(dict(name=person["name"], items=items))
    zip_ = household.get("zip")
    emp = EMPOWER["zip"].get(zip_) if zip_ else None
    county = EMPOWER["county"][place["fips"]]
    return dict(
        household=dict(id=household["id"], name=household["name"], place=household["place"], place_label=place["label"], zip=zip_),
        event=dict(key=place["event"], name=ev["name"], hours_over_10pct=need, peak=ev["peak"], peak_pct=ev["peak_pct"],
                   pct_72h=ev["pct_72h"], out_72h_after_peak=ev["out_72h_after_peak"], harm=HARM[place["event"]]),
        empower=dict(scope="zip", zip=zip_, **emp) if emp else dict(scope="county", **county),
        people=people, plan_fraction=PLAN_FRACTION)


def tally(facts):
    t = dict(ready=0, short=0, gap=0, check=0)
    for p in facts["people"]:
        for i in p["items"]:
            t[i["status"]] += 1
    return t
