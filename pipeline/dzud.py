"""Dzud: the chance that a soum loses 6 % or more of its adult livestock, from the winter so far.

Four indicators per 0.1 degree cell, each a z-score clipped to 3, higher meaning worse:
    snow    mean of ln(1 + cm) from 1 November to the day, against the cell's own winters 2001-2020
    cold    mean 13:00 air temperature over the same days, sign turned
    press   ln of sheep units per km2 of pasture, census of the year before the winter, against the other soums
    summer  July-August NDVI before the winter, sign turned
The weights are published (WEIGHTS) and are not fitted: on 14 winters, weights fitted to losses did worse on a winter
they had not seen (docs/DZUD_CHECK.md). Only two numbers per date are fitted, which turn the index into a chance.

A winter is named by the year it starts in. The season is 1 November to 31 March; other days have no score.

    python dzud.py climate      per-cell climate and herd pressure -> model_dzud.npz (from the 26-year cache)
    python dzud.py calibrate    chance, checks -> model.json ["dzud"]
"""
import csv
import datetime as dt
import json
import os
import sys
import warnings

import numpy as np

import common as C
import load as L
from fetch_era5 import BANDS, CACHE

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "model.json")
GRIDS = os.path.join(HERE, "model_dzud.npz")
HERDS = os.path.join(HERE, "nso_soums.csv")
SOUMS = os.path.join(HERE, "..", "data", "soums.geojson")

# Correlations with livestock deaths in Nandintsetseg et al. (2018), Sci. Rep. 8:14769, Table 1 (aimags, 2000-2014). Their
# summer term is a rain index, ours is NDVI; hay, the strongest term there (-0.46), has no soum data and is left out.
WEIGHTS = dict(snow=0.41, cold=0.35, press=0.29, summer=0.24)
PARTS = ("snow", "cold", "press", "summer")
CLIP = 3.0
BASELINE = range(2001, 2021)  # winters, by the year they start in
EVENT = 0.06                  # livestock insurance pays from about 6 % (CDKN 2013)
LAST_DAY = 150                # 31 March
NODES = (0, 14, 29, 44, 60, 75, 91, 106, 119, 135, 150)  # days of the season where climate and chance are tabulated
SD_FLOOR = dict(t=0.3, snow=0.1, ndvi=0.01)  # a Gobi cell that had no snow in 20 winters must not score 3 on a trace
SMALL_KM2 = 300               # towns: their registered herds graze the aimag, so they take its density
KM2 = 111.32 ** 2 * C.DX * C.DY


# ------------------------------------------------------------------- season
def winter_of(d):
    if d.month >= 11:
        return d.year
    return d.year - 1 if d.month <= 3 else None


def season_day(d):
    """1 November is 0 and 31 March is 150. 29 February shares day 120 with 1 March, so every winter has the same days."""
    k = (d - dt.date(winter_of(d), 11, 1)).days
    leap = d.month == 3 and (dt.date(d.year, 3, 1) - dt.date(d.year, 2, 28)).days == 2
    return k - 1 if leap else k


def at_node(table, k):
    """Value on season day k, linear between the nodes. table: [node, ...]."""
    i = min(max(int(np.searchsorted(NODES, k, side="right")) - 1, 0), len(NODES) - 2)
    f = (k - NODES[i]) / (NODES[i + 1] - NODES[i])
    return table[i] * (1 - f) + table[i + 1] * f


class Acc:
    """The winter so far: sums of noon temperature and ln(1 + snow) since 1 November. A cell with a missing day is missing."""

    def __init__(self, shape=(C.NY, C.NX)):
        self.n, self.t, self.s = 0, np.zeros(shape), np.zeros(shape)

    def add(self, t, sd):
        self.n += 1
        self.t = self.t + t
        self.s = self.s + np.log1p(np.maximum(sd, 0.0))

    def mean(self):
        return self.t / self.n, self.s / self.n

    def copy(self):
        a = Acc(self.t.shape)
        a.n, a.t, a.s = self.n, self.t.copy(), self.s.copy()
        return a

    def save(self, path):
        np.savez_compressed(path, n=self.n, t=self.t.astype(np.float32), s=self.s.astype(np.float32))

    @staticmethod
    def load(path):
        z = np.load(path)
        a = Acc(z["t"].shape)
        a.n, a.t, a.s = int(z["n"]), z["t"].astype(np.float64), z["s"].astype(np.float64)
        return a


# -------------------------------------------------------------------- index
def zscore(x, mu, sd, floor):
    return np.clip((x - mu) / np.maximum(sd, floor), -CLIP, CLIP)


def index(snow, cold, press, summer):
    z = dict(snow=snow, cold=cold, press=press, summer=summer)
    return sum(WEIGHTS[k] * z[k] for k in PARTS) / sum(WEIGHTS.values())


def weather_z(acc, k, grids):
    """(snow z, cold z) of the winter so far on season day k."""
    t, s = acc.mean()
    return (zscore(s, at_node(grids["s_mu"], k), at_node(grids["s_sd"], k), SD_FLOOR["snow"]),
            -zscore(t, at_node(grids["t_mu"], k), at_node(grids["t_sd"], k), SD_FLOOR["t"]))


def summer_ndvi(y):
    """July-August NDVI of year y, or None while either month is not in the cache."""
    a = [L.veg(y, m)[0] for m in (7, 8)]
    if not all(np.isfinite(v).any() for v in a):
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # cells outside the data in both months
        return np.nanmean(a, axis=0)


def summer_z(ndvi, grids):
    return -zscore(ndvi, grids["n_mu"], grids["n_sd"], SD_FLOOR["ndvi"])


def press_z(winter, grids):
    """Herd pressure of the census of the year before the winter. A census not in the file yet: the latest there is."""
    years = [int(v) for v in grids["p_years"]]
    return grids["press"][years.index(min(max(winter - 1, years[0]), years[-1]))]


# ------------------------------------------------------------------- inputs
def season_days(winter):
    """(date, noon temperature, snow depth cm) of every day of the season in the cache, in order. Stops at a gap."""
    ti, si = BANDS.index("t"), BANDS.index("sd")
    expect = dt.date(winter, 11, 1)
    for y, m in ((winter, 11), (winter, 12), (winter + 1, 1), (winter + 1, 2), (winter + 1, 3)):
        for half, first in (("a", 1), ("b", 17)):
            p = os.path.join(CACHE, "era5", f"{y}{m:02d}{half}.npy")
            if not os.path.exists(p):
                return
            a = np.load(p, mmap_mode="r")
            t, s = np.array(a[ti], np.float32), np.array(a[si], np.float32)
            for j in range(a.shape[1]):
                d = dt.date(y, m, first + j)
                if d != expect:
                    return
                yield d, t[j], s[j]
                expect = d + dt.timedelta(days=1)


def in_ring(x, y, ring):
    r = np.asarray(ring)
    inside = np.zeros(x.shape, bool)
    for (x1, y1), (x2, y2) in zip(r[:-1], r[1:]):
        if y1 != y2:
            inside ^= ((y1 > y) != (y2 > y)) & (x < (x2 - x1) * (y - y1) / (y2 - y1) + x1)
    return inside


def polygons(geom):
    return [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]


def area_km2(geom):
    total = 0.0
    for poly in polygons(geom):
        for j, ring in enumerate(poly):
            r = np.asarray(ring)
            x, y = r[:, 0] * 111.32 * np.cos(np.radians(r[:, 1].mean())), r[:, 1] * 111.32
            a = abs(np.dot(x[:-1], y[1:]) - np.dot(x[1:], y[:-1])) / 2
            total += a if j == 0 else -a
    return total


def load_soums():
    """[(properties, km2, flat indices of its cells)]. As js/soums.js: cells whose centre lies inside, else the middle one."""
    X, Y = np.meshgrid(C.LON, C.LAT)
    out = []
    for f in json.load(open(SOUMS, encoding="utf-8"))["features"]:
        m = np.zeros(X.shape, bool)
        for poly in polygons(f["geometry"]):
            q = in_ring(X, Y, poly[0])
            for hole in poly[1:]:
                q &= ~in_ring(X, Y, hole)
            m |= q
        if not m.any():
            p = np.concatenate([np.asarray(poly[0]) for poly in polygons(f["geometry"])])
            lo, hi = p.min(0), p.max(0)
            m[min(C.NY - 1, int((C.NORTH - (lo[1] + hi[1]) / 2) / C.DY)), min(C.NX - 1, int(((lo[0] + hi[0]) / 2 - C.WEST) / C.DX))] = True
        out.append((f["properties"], area_km2(f["geometry"]), np.flatnonzero(m)))
    return out


def soum_of_cell(soums, cells):
    """Soum index of every cell of the country; border cells whose centre lies outside every soum take the nearest one."""
    owner = np.full(C.NY * C.NX, -1)
    for i in sorted(range(len(soums)), key=lambda i: -len(soums[i][2])):  # small soums last: they are not painted over
        owner[soums[i][2]] = i
    own = owner.reshape(C.NY, C.NX)
    r0, c0 = np.nonzero(own >= 0)
    for r, c in zip(*np.nonzero(cells & (own < 0))):
        j = np.argmin((r0 - r) ** 2 + ((c0 - c) * np.cos(np.radians(C.LAT[r]))) ** 2)
        owner[r * C.NX + c] = own[r0[j], c0[j]]
    return owner.reshape(C.NY, C.NX)


def herds():
    """{(soum, year): (stock, loss)} in thousand sheep units, None where not published."""
    num = lambda v: float(v) if v else None
    return {(int(r["soum_index"]), int(r["year"])): (num(r["stock_su"]), num(r["loss_su"])) for r in csv.DictReader(open(HERDS, encoding="utf-8"))}


def pasture_share(s):
    """Share of each cell that is grazed: MODIS land cover, half of bare ground counted."""
    return np.clip(s["lc_grass"] + s["lc_shrub"] + s["lc_savanna"] + s["lc_crop"] + 0.5 * s["lc_barren"], 0.05, 1.0)


def pressure_by_soum(year, soums, share, table):
    """ln sheep units per km2 of pasture, as a z-score across the soums of that census. NaN where there is no herd."""
    stock = np.array([(table.get((i, year)) or (None, None))[0] or np.nan for i in range(len(soums))], float)
    km2 = np.array([a * float(np.mean(share.ravel()[idx])) for _, a, idx in soums])
    town = np.array([a < SMALL_KM2 or p["aimag"] == "Ulaanbaatar" for p, a, _ in soums])
    aimag = np.array([p["aimag"] for p, _, _ in soums])
    dens = stock / km2
    for i in np.flatnonzero(town):
        k = (aimag == aimag[i]) & np.isfinite(stock)
        dens[i] = stock[k].sum() / km2[k].sum() if k.any() else np.nan
    v = np.log(dens * 1000.0)
    v[~np.isfinite(v)] = np.nan
    return np.clip((v - np.nanmean(v)) / np.nanstd(v), -CLIP, CLIP)


# ------------------------------------------------------------------ climate
def climate():
    """Mean and spread of the four inputs per cell, and the herd pressure of every census."""
    s = L.static()
    cells = s["mask"] > 0.02
    T, S = [np.full((len(BASELINE), len(NODES), C.NY, C.NX), np.nan, np.float32) for _ in range(2)]
    for w, winter in enumerate(BASELINE):
        acc = Acc()
        for d, t, sd in season_days(winter):
            acc.add(t, sd)
            k = season_day(d)
            if k in NODES:  # 29 February comes before 1 March; day 120 is not a node
                T[w, NODES.index(k)], S[w, NODES.index(k)] = acc.mean()
        print(winter, acc.n, flush=True)
    ndvi = np.array([summer_ndvi(y) for y in BASELINE])
    soums = load_soums()
    owner, share, table = soum_of_cell(soums, cells), pasture_share(s), herds()
    years = sorted({y for (_, y), (a, _) in table.items() if a is not None})
    press = []
    for y in years:
        z = np.append(pressure_by_soum(y, soums, share, table), np.nan)
        press.append(np.where(cells, z[owner], np.nan))
    half = lambda a: np.asarray(a, np.float32)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        np.savez_compressed(GRIDS, t_mu=half(T.mean(0)), t_sd=half(T.std(0)), s_mu=half(S.mean(0)), s_sd=half(S.std(0)),
                            n_mu=half(np.nanmean(ndvi, 0)), n_sd=half(np.nanstd(ndvi, 0)), press=half(press), p_years=years, nodes=NODES)
    print("written", round(os.path.getsize(GRIDS) / 1e6, 1), "MB", "censuses", years[0], years[-1])


def grids():
    z = np.load(GRIDS)
    return {k: z[k] for k in z.files}


if __name__ == "__main__":
    dict(climate=climate)[sys.argv[1]]()
