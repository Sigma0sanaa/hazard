"""Write the dzud files the page reads (see docs/GEE_DATA_FORMAT.md). Called by build.py; `python build.py dzud` runs it alone.

    data/gee/dzud/YYYY-MM.bin.gz     uint8 [day][score, snow z, cold z][NY][NX], months of the season only, each day after
                                     the first stored as the change from the day before (modulo 256): a fifth of the size
    data/gee/dzud/season_YYYY.bin.gz uint8 [press z, summer z][NY][NX], one per winter
    data/gee/monthly_dzud.bin.gz, highdays_dzud.bin.gz   as for the other hazards, no data outside the season

They are kept apart from daily/ so that the layout of the older files stays as it was. The winter so far is a sum over
its days, and the daily job starts from an empty cache, so the sums at the start of each month are kept in pipeline/state.
"""
import calendar
import datetime as dt
import glob
import gzip
import os

import numpy as np

import common as C
import dzud as D

BANDS = ("dzud", "snow", "cold")
SEASON = (11, 3)
FIRST_WINTER = 2001
HIGH = 60
KEEP_STATES = 3


def encode_z(z):
    """z -3..3 as 0..240 in steps of 10 (a quarter of a standard deviation, for the bars of the page), no data 255."""
    out = np.full(z.shape, C.NODATA, np.uint8)
    ok = np.isfinite(z)
    out[ok] = (np.rint((np.clip(z[ok], -D.CLIP, D.CLIP) + D.CLIP) / (2 * D.CLIP) * 24) * 10).astype(np.uint8)
    return out


def delta(a):
    """Each day as its change from the day before, modulo 256. The page adds them up again (js/dzud.js)."""
    d = a.copy()
    d[1:] = a[1:] - a[:-1]
    return d


def undelta(d):
    return np.cumsum(d, axis=0, dtype=np.uint8)


def write_gz(path, arr):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", compresslevel=9, mtime=0) as g:
        g.write(arr.tobytes())


def read_cube(path):
    if not os.path.exists(path):
        return {}
    a = np.frombuffer(gzip.open(path).read(), np.uint8).reshape(-1, C.NY, C.NX)
    return dict(enumerate(a))


def day_score(acc, k, fixed, g, m):
    """(score 0..100, snow z, cold z) of season day k."""
    snow, cold = D.weather_z(acc, k, g)
    x = D.index(snow, cold, *fixed)
    a, b = D.at_node(np.array(m["a"]), k), D.at_node(np.array(m["b"]), k)
    return D.to_score(1 / (1 + np.exp(-(a + b * x))), m["base"]), snow, cold


def summer(y, state):
    """July-August NDVI before the winter: from the cache, else as the state kept it, else None."""
    n = D.summer_ndvi(y)
    p = os.path.join(state, f"dzud_summer_{y}.npz")
    if n is not None:
        os.makedirs(state, exist_ok=True)
        np.savez_compressed(p, ndvi=np.asarray(n, np.float32))
        return n
    return np.load(p)["ndvi"] if os.path.exists(p) else None


def month_start(d, winter):
    """First day of d's month, or the first day of the winter if that is later."""
    return max(dt.date(d.year, d.month, 1), dt.date(winter, 11, 1))


def build(out, state, start, last_day, g, m, cells, bridge=(), last_snow=None):
    """start: (year, month) to recompute from, or None for everything. last_day: last day of the other hazards.
    bridge: (date, noon temperature) of the days after ERA5-Land; their snow stays as on the last ERA5-Land day, which is
    last_snow when that day came before the winter."""
    cubes = {k: read_cube(os.path.join(out, f"{k}_dzud.bin.gz")) if start else {} for k in ("monthly", "highdays")}
    begin = dt.date(*(start or (FIRST_WINTER, 11)), 1)
    winters = range(FIRST_WINTER, last_day.year + 1)
    snaps, missing = {}, []
    # the summer is only whole in the cache for a few weeks of the year, so it is put aside whenever it is
    for y in {begin.year, last_day.year}:
        summer(y, state)
    for winter in winters:
        first, end = dt.date(winter, 11, 1), dt.date(winter + 1, 3, 31)
        if end < begin or first > last_day:
            continue
        ndvi = summer(winter, state)
        if ndvi is None:
            missing.append(f"{winter}: no summer NDVI")
            continue
        fixed = (D.press_z(winter, g), D.summer_z(ndvi, g))
        write_gz(os.path.join(out, "dzud", f"season_{winter}.bin.gz"), np.stack([np.where(cells, encode_z(z), C.NODATA) for z in fixed]).astype(np.uint8))
        acc, day0 = D.Acc((C.NY, C.NX)), first
        if begin > first:
            p = os.path.join(state, f"dzud_{begin:%Y-%m}.npz")
            if not os.path.exists(p):
                missing.append(f"{winter}: no state of {begin:%Y-%m}")
                continue
            acc, day0 = D.Acc.load(p), begin
        frames, sd = {}, last_snow

        def one(d, t, snow):
            if d.day == 1 and d > first:
                snaps[d] = acc.copy()
            acc.add(t, snow)
            sc, zs, zc = day_score(acc, D.season_day(d), fixed, g, m)
            frames.setdefault((d.year, d.month), {})[d.day] = [np.where(cells, v, np.nan) for v in (sc, zs, zc)]

        d = None
        for d, t, sd in D.season_days(winter, day0):
            one(d, t, sd)
        for b, t in bridge:
            after = d if d else day0 - dt.timedelta(days=1)
            if b <= end and b == after + dt.timedelta(days=1) and sd is not None:
                one(b, t, sd)
                d = b
        for (y, mo), days in frames.items():
            arr = np.full((calendar.monthrange(y, mo)[1], len(BANDS), C.NY, C.NX), C.NODATA, np.uint8)
            for day, (sc, zs, zc) in days.items():
                arr[day - 1] = C.encode(sc), encode_z(zs), encode_z(zc)
            write_gz(os.path.join(out, "dzud", f"{y}-{mo:02d}.bin.gz"), delta(arr))
            stack = np.array([v[0] for v in days.values()])
            k = (y - 2001) * 12 + mo - 1
            cubes["monthly"][k] = C.encode(stack.mean(0))
            n = np.minimum((stack >= HIGH).sum(0), 254).astype(np.uint8)
            n[~np.isfinite(stack).all(0)] = C.NODATA
            cubes["highdays"][k] = n
    blank = np.full((C.NY, C.NX), C.NODATA, np.uint8)
    n = (last_day.year - 2001) * 12 + last_day.month
    for name, c in cubes.items():
        write_gz(os.path.join(out, f"{name}_dzud.bin.gz"), np.stack([c.get(k, blank) for k in range(n)]))
    save_states(state, snaps)
    if missing:
        print("dzud, not computed:", "; ".join(missing), flush=True)
    return missing


def save_states(state, snaps):
    """The sums at the start of the latest months, for the daily job. Older ones go, the summers of two years stay."""
    os.makedirs(state, exist_ok=True)
    for d in sorted(snaps)[-KEEP_STATES:]:
        snaps[d].save(os.path.join(state, f"dzud_{d:%Y-%m}.npz"))
    for pattern, keep in (("dzud_[0-9]*.npz", KEEP_STATES), ("dzud_summer_*.npz", 2)):
        for p in sorted(glob.glob(os.path.join(state, pattern)))[:-keep]:
            os.remove(p)


def manifest_part(m):
    """What manifest.json says about dzud."""
    src = lambda n, r, role: dict(name=n, resolution=r, role=role)
    keys = ("reference", "period", "n", "auc", "auc_ci", "pod", "far", "csi", "brier", "bss", "share_flagged")
    return dict(
        info=dict(bands=list(BANDS), season=list(SEASON), first_winter=FIRST_WINTER, early_month=11, base=m["base"], event=m["event"], weights=m["weights"]),
        verification={k: m["verification"][k] for k in keys},
        uncertainty=dict(u_model=round(m["u_model"], 2)),
        sources=[src("ERA5-Land (ECMWF)", "0.1°", "Snow depth, air temperature since 1 November"), src("MODIS MCD43A4", "500 m", "July-August NDVI"),
                 src("NSO Mongolia (1212.mn)", "soum", "Herds (pressure), adult losses (calibration)"), src("MODIS MCD12Q1", "500 m", "Pasture share"), src("NOAA GFS", "0.25°", "Temperature of the last days")])
