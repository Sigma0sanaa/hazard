"""Herds and losses of adult livestock by soum, from the National Statistics Office of Mongolia (data.1212.mn, no login).

Written to nso_soums.csv in thousand sheep units, run by hand once a year, when the December census comes out (about
February) and the losses of the year before are in. soum_index is the position of the soum in data/soums.geojson.
Soum losses start in 2012, herds in 2000 here. An empty field is "no figure", never zero.

    python fetch_nso.py
"""
import csv
import difflib
import json
import os
import re
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "nso_soums.csv")
SOUMS = os.path.join(HERE, "..", "data", "soums.geojson")
BASE = "https://data.1212.mn/api/v1/mn/NSO/Industry,%20service/Livestock/"
TABLES = dict(stock="DT_NSO_1001_021V1", loss="DT_NSO_1001_029V1")
TOTAL = "Бүгд"
KINDS = {"Тэмээ": "camel", "Адуу": "horse", "Үхэр": "cattle", "Хонь": "sheep", "Ямаа": "goat"}
# Sheep units per head: Nandintsetseg et al. (2018), Sci. Rep. 8:14769, Methods
UNITS = dict(camel=5.0, horse=7.0, cattle=6.0, sheep=1.0, goat=0.9)
FIRST_YEAR = 2000
ROUNDING = 0.25  # thousand head: five kinds printed to 0.1
BATCH = 40
CLOSE = 0.72  # spelling similarity below which two names of one aimag are not taken for the same soum


def parse(v):
    """PxWeb cell: '-' is a true zero, '..' and blank are missing."""
    v = v.strip()
    if v == "-":
        return 0.0
    try:
        return float(v)
    except ValueError:
        return None


def sheep_units(heads):
    if any(heads.get(k) is None for k in UNITS):
        return None
    return sum(UNITS[k] * heads[k] for k in UNITS)


def fill(heads, total):
    """Kinds published as "..", settled by the total of the same table. Nearly always a soum without camels: the other
    four add up to the total. One kind missing is the difference; several are zero only when the total is already met."""
    missing = [k for k in UNITS if heads.get(k) is None]
    if not missing or total is None:
        return heads
    rest = total - sum(v for k, v in heads.items() if k in UNITS)
    if abs(rest) <= ROUNDING:
        return {**heads, **{k: 0.0 for k in missing}}
    return {**heads, missing[0]: rest} if len(missing) == 1 and rest > 0 else heads


def norm(name):
    s = re.sub(r"\s+(сум|дүүрэг)$", "", name.strip().lower())
    s = s.replace("ё", "е").replace("гөвь", "говь").replace("ь", "").replace("ъ", "")
    return re.sub(r"[\s\-]", "", s)


def match(nso, soums):
    """NSO region code of each soum: the same name inside the same aimag first, then the closest spelling there."""
    aimag = {norm(n): c for c, n in nso.items() if len(c) == 3}
    out = {}
    for a in sorted({norm(s["aimag_mn"]) for s in soums}):
        code = aimag.get(a) or next((aimag[x] for x in difflib.get_close_matches(a, list(aimag), 1, 0.8)), None)
        if code is None:
            continue
        pool = {norm(n): c for c, n in nso.items() if len(c) == 5 and c.startswith(code)}
        rest = []
        for i, s in enumerate(soums):
            if norm(s["aimag_mn"]) != a:
                continue
            n = norm(s["name_mn"])
            if n in pool:
                out[i] = pool.pop(n)
            else:
                rest.append((i, n))
        pairs = sorted(((difflib.SequenceMatcher(None, n, p).ratio(), i, p) for i, n in rest for p in pool), reverse=True)
        for r, i, p in pairs:
            if r >= CLOSE and i not in out and p in pool:
                out[i] = pool.pop(p)
    return out


def local_example():
    """A small case for the test: two aimags that each have a soum of the same name."""
    nso = {"181": "Завхан", "182": "Ховд", "18101": "Дарви", "18201": "Дарви сум", "18202": "Мөст"}
    return nso, [dict(name_mn="Дарви", aimag_mn="Завхан"), dict(name_mn="Дарви", aimag_mn="Ховд")]


def get(table, query=None):
    data = json.dumps(query).encode() if query else None
    for attempt in range(4):
        try:
            req = urllib.request.Request(BASE + table + ".px", data=data, headers={"Content-Type": "application/json"})
            return json.loads(urllib.request.urlopen(req, timeout=120).read().decode("utf-8-sig"))
        except OSError:
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))


def fetch(table):
    """({(region, year): {kind: thousand head}}, {region: name}) for aimags and soums."""
    kind, region, year = get(table)["variables"]
    kinds = {c: KINDS[t.strip()] for c, t in zip(kind["values"], kind["valueTexts"]) if t.strip() in KINDS}
    years = {c: int(t) for c, t in zip(year["values"], year["valueTexts"]) if int(t) >= FIRST_YEAR}
    names = {c: t.strip() for c, t in zip(region["values"], region["valueTexts"]) if len(c) in (3, 5)}
    kinds.update({c: "total" for c, t in zip(kind["values"], kind["valueTexts"]) if t.strip() == TOTAL})
    if set(kinds.values()) != {*UNITS, "total"}:
        raise SystemExit(f"{table}: the kinds of livestock changed: {kinds}")
    out, codes = {}, sorted(names)

    def sel(v, values):
        return dict(code=v["code"], selection=dict(filter="item", values=list(values)))

    for i in range(0, len(codes), BATCH):
        r = get(table, dict(query=[sel(kind, kinds), sel(region, codes[i:i + BATCH]), sel(year, years)], response=dict(format="json")))
        cols = [c["code"] for c in r["columns"]]
        for cell in r["data"]:
            k = dict(zip(cols, cell["key"]))
            v = parse(cell["values"][0])
            if v is not None:
                out.setdefault((k[region["code"]], years[k[year["code"]]]), {})[kinds[k[kind["code"]]]] = v
    return {k: fill({x: v for x, v in h.items() if x != "total"}, h.get("total")) for k, h in out.items()}, names


def main():
    soums = [f["properties"] for f in json.load(open(SOUMS, encoding="utf-8"))["features"]]
    stock, names = fetch(TABLES["stock"])
    loss, _ = fetch(TABLES["loss"])
    m = match(names, soums)
    print(f"matched {len(m)}/{len(soums)}; not matched:", [f"{s['name']} ({s['aimag']})" for i, s in enumerate(soums) if i not in m])
    years = sorted({y for _, y in stock} | {y for _, y in loss})
    with open(OUT, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["soum_index", "year", "stock_su", "loss_su"])
        for i in sorted(m):
            for y in years:
                a, b = sheep_units(stock.get((m[i], y), {})), sheep_units(loss.get((m[i], y), {}))
                if a is not None or b is not None:
                    w.writerow([i, y, *("" if v is None else f"{v:.4f}" for v in (a, b))])
    n = ev = 0
    rows = {(int(r["soum_index"]), int(r["year"])): r for r in csv.DictReader(open(OUT, encoding="utf-8"))}
    for (i, y), r in rows.items():
        p = rows.get((i, y - 1))
        if r["loss_su"] and p and p["stock_su"] and float(p["stock_su"]) > 0:
            n += 1
            ev += float(r["loss_su"]) / float(p["stock_su"]) >= 0.06
    print(f"soum-winters with losses {n}, loss >= 6 %: {ev} ({100 * ev / n:.1f} %)")


if __name__ == "__main__":
    main()
