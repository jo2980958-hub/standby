"""Builds backend/data/events.json from the saved research files.
Run once; the app reads only the output. Every number comes from the files in
research/data (EAGLE-I county outages, NWS text products, HHS emPOWER)."""
import csv, json, re, statistics, datetime as dt
from pathlib import Path

R = Path(__file__).resolve().parents[2] / "research" / "data"
OUT = Path(__file__).resolve().parent / "data" / "events.json"

EVENTS = {
    "irma": dict(name="Hurricane Irma", county="Broward", state="FL", fips="12011",
                 csv="eaglei-2017-irma-FL-4counties.csv", nws="irma-HLSMFL-2017-09-08to11.txt",
                 start="2017-09-08", end="2017-09-22", tz=None),
    "uri": dict(name="Winter Storm Uri", county="Travis", state="TX", fips="48453",
                csv="eaglei-2021-uri-TX-3counties.csv", nws="uri-WSWEWX-2021-02-12to18.txt",
                start="2021-02-12", end="2021-02-24"),
    "beryl": dict(name="Hurricane Beryl", county="Harris", state="TX", fips="48201",
                  csv="eaglei-2024-beryl-helene.csv", nws="beryl-HLSHGX-2024-07-06to08.txt",
                  start="2024-07-06", end="2024-07-21"),
}
TZ = {"EDT": -4, "EST": -5, "CDT": -5, "CST": -6}
MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}


def mcc(fips):
    for r in csv.DictReader(open(R / "eaglei-MCC.csv", encoding="utf-8-sig")):
        if r["County_FIPS"] == str(int(fips)):
            return int(r["Customers"])


def series(ev):
    total = mcc(ev["fips"])
    rows = []
    for r in csv.DictReader(open(R / ev["csv"])):
        if r["fips_code"] != ev["fips"]:
            continue
        t = r["run_start_time"][:10]
        if ev["start"] <= t <= ev["end"]:
            rows.append((dt.datetime.fromisoformat(r["run_start_time"]), min(int(r["customers_out"]), total)))
    rows.sort()
    # drop single-reading glitches: 5-point median filter
    v = [x[1] for x in rows]
    sm = [int(statistics.median(v[max(0, i - 2): i + 3])) for i in range(len(v))]
    return total, [(rows[i][0], sm[i]) for i in range(len(rows))]


SMALL = {"in", "of", "to", "for", "and", "the", "a", "on", "at", "until", "by", "is", "are"}
KEEP = {"cst", "cdt", "edt", "est", "tx", "fl", "ne", "nw", "se", "sw"}


def tidy(h):
    h = re.sub(r"\s+", " ", h).strip()
    h = re.sub(r"(\s*\.{2,}\s*)+", " - ", h).strip(" -")
    if h.isupper():
        words = h.lower().split()
        h = " ".join(w.upper() if w in KEEP else (w if (i and w in SMALL) else w.capitalize())
                     for i, w in enumerate(words))
    return h if len(h) <= 100 else h[:100].rsplit(' ', 1)[0] + '\u2026'


def products(ev):
    txt = (R / "nws" / ev["nws"]).read_text(errors="ignore")
    out = []
    for blk in re.split(r"\n(?=[A-Z]{4}\d{2} [A-Z]{4} \d{6})", txt):
        h = re.match(r"([A-Z]{4}\d{2}) ([A-Z]{4}) (\d{2})(\d{2})(\d{2})", blk)
        if not h:
            continue
        loc = re.search(r"^(\d{1,4}) ([AP]M) ([A-Z]{3}) \w{3} (\w{3}) (\d{1,2}) (\d{4})", blk, re.M)
        if not loc:
            continue
        hm, ap, tz, mon, day, yr = loc.groups()
        hm = hm.zfill(4); hh = int(hm[:2]) % 12 + (12 if ap == "PM" else 0)
        local = dt.datetime(int(yr), MONTHS[mon], int(day), hh, int(hm[2:]))
        utc = local - dt.timedelta(hours=TZ[tz])
        head = re.search(r"\*\*(.+?)\*\*", blk, re.S) or re.search(r"^\.\.\.(.+?)\.\.\.$", blk, re.M)
        if not head:
            continue
        out.append(dict(utc=utc.isoformat(), local=f"{local:%a %-d %b, %-I:%M %p} {tz}",
                        headline=tidy(head.group(1))))
    out.sort(key=lambda p: p["utc"])
    return out


def main():
    res = {}
    for key, ev in EVENTS.items():
        total, s = series(ev)
        peak_t, peak = max(s, key=lambda x: x[1])
        over = [t for t, v in s if v >= 0.10 * total]
        hours_over = len(over) * 0.25
        span = (max(over) - min(over)).total_seconds() / 3600
        at72 = next(v for t, v in s if t >= peak_t + dt.timedelta(hours=72))
        hourly = [(t.isoformat(), v) for t, v in s if t.minute == 0 and t.hour % 3 == 0]
        res[key] = dict(key=key, name=ev["name"], county=ev["county"], state=ev["state"], total_customers=total,
                        peak=peak, peak_pct=round(100 * peak / total), peak_at=peak_t.isoformat(),
                        out_72h_after_peak=at72, pct_72h=round(100 * at72 / total),
                        hours_over_10pct=round(hours_over), span_over_10pct_h=round(span),
                        curve=hourly, notices=products(ev))
        print(key, total, peak, res[key]["peak_pct"], hours_over, span, at72, len(res[key]["notices"]))
    OUT.write_text(json.dumps(res))


main()
