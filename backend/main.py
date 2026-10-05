"""Standby: FastAPI serving the static console and the API on one port."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import agent
from engine import CATALOGUE, EVENTS, PLACES, build_facts, catalogue_public, tally
from households import EXAMPLES

HERE = Path(__file__).resolve().parent
WEB = Path(os.environ.get("WEB_DIR", HERE.parent / "web"))
app = FastAPI(title="Standby")

RUNS: list[float] = []  # live-call timestamps, caps spend for everyone
MAX_RUNS_PER_HOUR = 30


class Device(BaseModel):
    device: str
    opts: dict[str, str] = {}


class Person(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    devices: list[Device] = Field(max_length=6)


class Household(BaseModel):
    id: str = "custom"
    name: str = Field(min_length=1, max_length=60)
    place: str
    zip: str | None = None
    people: list[Person] = Field(min_length=1, max_length=4)


def _valid(h: dict) -> None:
    if h["place"] not in PLACES:
        raise HTTPException(422, "Unknown area")
    n = 0
    for p in h["people"]:
        for d in p["devices"]:
            n += 1
            if d["device"] not in CATALOGUE:
                raise HTTPException(422, f"Unknown device {d['device']}")
            key = CATALOGUE[d["device"]]["option"]["key"]
            ok = [c[0] for c in CATALOGUE[d["device"]]["option"]["choices"]]
            if d["opts"].get(key) not in ok:
                raise HTTPException(422, f"Choose {CATALOGUE[d['device']]['option']['label'].lower()} for {CATALOGUE[d['device']]['label']}")
    if n == 0:
        raise HTTPException(422, "Add at least one device")


def _finish(facts: dict) -> dict:
    facts["tally"] = tally(facts)
    return facts


@app.get("/api/meta")
def meta():
    return dict(catalogue=catalogue_public(), places=[dict(id=k, label=v["label"], event=EVENTS[v["event"]]["name"]) for k, v in PLACES.items()])


@app.get("/api/households")
def households():
    out = []
    for h in EXAMPLES:
        f = build_facts(h)
        out.append(dict(id=h["id"], name=h["name"], place_label=f["household"]["place_label"], event=f["event"]["name"],
                        tally=tally(f), people=[p["name"] for p in h["people"]], input=h))
    return out


@app.get("/api/pack/{hid}")
def pack(hid: str):
    f = HERE / "cache" / f"{hid}.json"
    if not f.exists():
        raise HTTPException(404, "No such household")
    return _finish(json.loads(f.read_text())["pack"])


@app.get("/api/events/{key}")
def event(key: str):
    if key not in EVENTS:
        raise HTTPException(404)
    return EVENTS[key]


@app.post("/api/run")
def run(h: Household):
    now = time.time()
    RUNS[:] = [t for t in RUNS if now - t < 3600]
    if len(RUNS) >= MAX_RUNS_PER_HOUR:
        raise HTTPException(429, "Too many live runs this hour. Try again later.")
    data = h.model_dump()
    _valid(data)
    facts = build_facts(data)
    RUNS.append(now)
    try:
        out = agent.run(facts)
    except SystemExit as e:
        raise HTTPException(503, "The model is not available right now.") from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"The model did not answer: {type(e).__name__}") from e
    return _finish(agent.merge(facts, out))


@app.get("/")
def index():
    return FileResponse(WEB / "index.html")


app.mount("/", StaticFiles(directory=WEB), name="web")
