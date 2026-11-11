"""Stage 3 (offline): the analysis of the UHG coal-dust study from the stage 1-2 files.

python analyze.py <folder with stage outputs> <folder for results>

Steps (numbers follow the study design):
 2. coal surfaces and coal-dust indices from Sentinel-2 / Landsat; mining footprint; distance and direction zones
 3. natural dust periods from MERRA-2 dust, Sentinel-5P AAI and ERA5 wind
 4. mine increment by difference-in-differences: downwind vs upwind, high vs low activity
 5. transport frequency from hourly ERA5 wind (simplified forward trajectories, stands in for HYSPLIT)
 6. accuracy of the coal-surface map against visually interpreted reference points (labels in accuracy_labels.csv)
"""
import csv
import glob
import gzip
import json
import math
import os
import sys

import numpy as np
from scipy import ndimage

IN = sys.argv[1] if len(sys.argv) > 1 else "out"
RES_DIR = sys.argv[2] if len(sys.argv) > 2 else "results"
os.makedirs(RES_DIR, exist_ok=True)
RNG = np.random.default_rng(42)

G = json.load(open(os.path.join(IN, "grid.json")))
N, R = G["n"], G["res"]
UX, UY = G["uhg_utm"]
# pixel centre coordinates of the 30 m grid
XC = G["x0"] + (np.arange(N) + 0.5) * R
YC = G["y0"] - (np.arange(N) + 0.5) * R
XX, YY = np.meshgrid(XC, YC)

THR_WIND = 6.0      # m/s, hours able to lift dust (also the site's emission-potential start)
BCI_THR = 0.8       # Li et al. 2024 bare-coal threshold
SECT = 16


def load_refl(path):
    z = np.load(path)
    d = z["data"].astype(np.float32)
    d[d == -32768] = np.nan
    d /= float(z["scale"])
    return dict(zip([str(b) for b in z["bands"]], d))


def indices(r):
    with np.errstate(divide="ignore", invalid="ignore"):
        n, s1, s2 = r["nir"], r["swir1"], r["swir2"]
        out = dict(
            NDCI=(s1 - n) / (s1 + n),
            ECDI=(s1 - n + s2) / (s1 + n - s2),
            BCI=(s2 - s1) / (n * (n + s1)),
            VIS=(r["blue"] + r["green"] + r["red"]) / 3,
            NDVI=(n - r["red"]) / (n + r["red"]),
            NDWI=(r["green"] - n) / (r["green"] + n),
        )
    return out


def bearing(dx, dy):
    return (np.degrees(np.arctan2(dx, dy)) + 360) % 360


def sector(b, k=SECT):
    w = 360 / k
    return (np.floor((b + w / 2) / w) % k).astype(int)


def save_json(name, obj):
    json.dump(obj, open(os.path.join(RES_DIR, name), "w", encoding="utf-8"), ensure_ascii=False, indent=1, default=float)


# ------------------------------------------------------------------ ERA5 wind and transport (steps 3 and 5)

def load_era5():
    rows = []
    with gzip.open(os.path.join(IN, "era5_hourly_uhg.csv.gz"), "rt") as f:
        rd = csv.DictReader(f)
        for r in rd:
            rows.append(r)
    t = np.array([np.datetime64(r["time"]) for r in rows])
    def col(k):
        return np.array([float(r[k]) if r[k] not in ("", "None") else np.nan for r in rows], np.float64)
    ws, wd = col("wind_speed_10m"), col("wind_direction_10m")
    return dict(t=t, ws=ws, wd=wd, gust=col("wind_gusts_10m"), pr=col("precipitation"), snow=col("snow_depth"),
                sm=col("soil_moisture_0_to_7cm"), rh=col("relative_humidity_2m"),
                u=-ws * np.sin(np.radians(wd)), v=-ws * np.cos(np.radians(wd)))


def dust_hours(e):
    return (e["ws"] >= THR_WIND) & (np.nan_to_num(e["pr"]) == 0) & (np.nan_to_num(e["snow"]) < 0.01)


def wind_rose(e, sel):
    toward = (e["wd"][sel] + 180) % 360
    s = sector(toward)
    cnt = np.bincount(s, minlength=SECT).astype(float)
    w3 = np.bincount(s, weights=e["ws"][sel] ** 3, minlength=SECT)
    return cnt / cnt.sum(), w3 / w3.sum()


def trajectories(e, sel, hours=(1, 3, 6)):
    """Forward displacement of air leaving the mine at every dust hour, with the hourly wind at the mine (uniform field)."""
    idx = np.nonzero(sel)[0]
    u, v = np.nan_to_num(e["u"]), np.nan_to_num(e["v"])
    out = {}
    for h in hours:
        dx = np.zeros(len(idx)); dy = np.zeros(len(idx))
        for k in range(h):
            j = np.clip(idx + k, 0, len(u) - 1)
            dx += u[j] * 3600; dy += v[j] * 3600
        out[h] = (dx, dy)
    return out


# ------------------------------------------------------------------ surfaces (step 2)

def footprint_from(coal, change=None, close_px=5, min_km2=0.3):
    """Mining footprint: coal surfaces (and strong surface change, if given), closed, holes filled, small bits dropped."""
    m = coal.copy()
    if change is not None:
        m |= change
    m = ndimage.binary_closing(m, structure=np.ones((3, 3)), iterations=close_px)
    m = ndimage.binary_fill_holes(m)
    lab, n = ndimage.label(m)
    if n:
        sizes = ndimage.sum(m, lab, range(1, n + 1)) * R * R / 1e6
        keep = np.zeros(n + 1, bool)
        keep[1:] = sizes >= min_km2
        m = keep[lab]
    return m


def zones(fp, centre):
    """Distance from the footprint edge (m) and bearing from the footprint centre (deg) for every pixel."""
    dist = ndimage.distance_transform_edt(~fp) * R
    cx, cy = centre
    brg = bearing(XX - cx, YY - cy)
    return dist, brg


def zone_median(val, mask, dist, sec, rings):
    """Median of val per (ring, sector); returns array [len(rings)-1, SECT] and pixel counts."""
    med = np.full((len(rings) - 1, SECT), np.nan)
    cnt = np.zeros((len(rings) - 1, SECT), int)
    ok = mask & np.isfinite(val)
    for i in range(len(rings) - 1):
        ring = ok & (dist >= rings[i]) & (dist < rings[i + 1])
        for s in range(SECT):
            v = val[ring & (sec == s)]
            cnt[i, s] = v.size
            if v.size >= 30:
                med[i, s] = np.median(v)
    return med, cnt
