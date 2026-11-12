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


# ------------------------------------------------------------------ inputs

def load_era5land():
    rows = []
    for p in sorted(glob.glob(os.path.join(IN, "era5land_hourly_uhg_*.csv.gz"))):
        with gzip.open(p, "rt") as f:
            rows += list(csv.DictReader(f))
    rows.sort(key=lambda r: r["time"])
    t = np.array([np.datetime64(r["time"]) for r in rows])
    f = lambda k: np.array([float(r[k]) if r[k] not in ("", "None") else np.nan for r in rows])
    u, v = f("u10"), f("v10")
    ws = np.hypot(u, v)
    wd = (np.degrees(np.arctan2(-u, -v)) + 360) % 360       # meteorological: direction the wind blows FROM
    return dict(t=t, u=u, v=v, ws=ws, wd=wd, pr=f("precip_m"), snow=f("snow_depth_m"), sm=f("swvl1"))


def dust_mask(e):
    return (e["ws"] >= THR_WIND) & (np.nan_to_num(e["pr"]) < 1e-4) & (np.nan_to_num(e["snow"]) < 0.01)


def load_daily_csv(pattern, cols):
    out = {}
    for p in sorted(glob.glob(os.path.join(IN, pattern))):
        for r in csv.DictReader(open(p)):
            vals = []
            for c in cols:
                try:
                    vals.append(float(r[c]))
                except (TypeError, ValueError):
                    vals.append(np.nan)
            out[r["date"]] = vals
    return out


def maiac():
    days, aod = [], []
    for p in sorted(glob.glob(os.path.join(IN, "maiac_*.npz"))):
        z = np.load(p)
        d = z["daily"].astype(np.float32)
        a = d[:, 0]
        a[d[:, 0] == -32768] = np.nan
        aod.append(a / 1000.0)
        days += [str(x) for x in z["days"]]
    return np.array(days), (np.concatenate(aod) if aod else None)


def zone_stat(val, sel):
    v = val[sel & np.isfinite(val)]
    return (float(np.mean(v)) if v.size else np.nan), int(v.size)


def boot_ci(x, n=2000, q=(2.5, 97.5)):
    x = np.asarray(x, float)
    x = x[np.isfinite(x)]
    if x.size < 5:
        return np.nan, np.nan
    m = RNG.choice(x, (n, x.size), replace=True).mean(1)
    return tuple(np.percentile(m, q))


# ------------------------------------------------------------------ main

RINGS = [0, 250, 500, 1000, 2000, 3000, 5000, 7500, 10000, 15000]
NEAR = (500, 5000)          # m from the footprint edge: the zone compared downwind vs upwind
FAR = (10000, 15000)        # m: background ring for the soil end member


def run():
    res = {}
    st = np.load(os.path.join(IN, "static.npz"))
    wc = st["data"][0].astype(int)
    # --- composites
    land = {}
    for p in sorted(glob.glob(os.path.join(IN, "landsat_*.npz"))):
        land[os.path.basename(p)[8:-4]] = indices(load_refl(p))
    s2 = {}
    for p in sorted(glob.glob(os.path.join(IN, "s2_20*.npz"))):
        s2[os.path.basename(p)[3:7]] = indices(load_refl(p))

    # --- footprint (step 2): coal surfaces of recent years + strong surface change since 2006-2008
    post, pre = land["2023_2025"], land["2006_2008"]
    coal_recent = np.zeros((N, N), bool)
    for y in ("2023", "2024", "2025"):
        if y in s2:
            coal_recent |= (s2[y]["BCI"] >= BCI_THR) & (s2[y]["NDWI"] <= -0.05)
    dvis = post["VIS"] - pre["VIS"]
    near_mine = np.hypot(XX - UX, YY - UY) <= 12000
    change = near_mine & (np.abs(dvis) >= 0.05)
    fp = footprint_from(coal_recent, change)
    lab, nlab = ndimage.label(fp)
    iu = lab[np.argmin(np.abs(YC - UY)), np.argmin(np.abs(XC - UX))]
    main = lab == iu if iu else fp
    cy, cx = ndimage.center_of_mass(main)
    centre = (G["x0"] + (cx + 0.5) * R, G["y0"] - (cy + 0.5) * R)
    dist, brg = zones(fp, centre)
    sec = sector(brg)
    valid = (~fp) & (wc != 50) & (wc != 80)
    res["footprint"] = dict(area_km2=float(fp.sum() * R * R / 1e6), main_area_km2=float(main.sum() * R * R / 1e6),
                            coal_recent_km2=float(coal_recent.sum() * R * R / 1e6), centre_utm=centre,
                            centre_offset_from_uhg_m=[centre[0] - UX, centre[1] - UY])

    # --- coal-dust cover fraction (dimidiate pixel model of Xia et al. 2022 with local end members)
    def soil_end(ix):
        return float(np.nanmedian(ix["ECDI"][valid & (dist >= FAR[0]) & (dist < FAR[1])]))

    def coal_end(ix):
        m = (ix["BCI"] >= BCI_THR) & (ix["NDWI"] <= -0.05) & fp
        return float(np.nanmedian(ix["ECDI"][m])), int(m.sum())

    # coal end member: from the composite itself; before mining (no coal yet) from the first mining-era composite of the same sensor
    ends = {}
    c_tm, n_tm = coal_end(land["2010_2011"])
    for tag, ix in land.items():
        c_, n_ = coal_end(ix)
        if n_ < 100:
            c_, n_ = (c_tm, n_tm) if n_tm >= 100 else coal_end(land["2023_2025"])
        s_ = soil_end(ix)
        ix["FCD"] = np.clip((ix["ECDI"] - s_) / (c_ - s_), 0, 1)
        ends["landsat_" + tag] = dict(soil=s_, coal=c_, coal_pixels=n_)
    for tag, ix in s2.items():
        c_, n_ = coal_end(ix)
        s_ = soil_end(ix)
        ix["FCD"] = np.clip((ix["ECDI"] - s_) / (c_ - s_), 0, 1)
        ends["s2_" + tag] = dict(soil=s_, coal=c_, coal_pixels=n_)
    res["fcd_end_members_ecdi_soil_coal"] = ends

    # --- wind and transport (steps 3, 5)
    e = load_era5land()
    yr = e["t"].astype("datetime64[Y]").astype(int) + 1970
    dm = dust_mask(e)
    op = dm & (yr >= 2009)
    toward = (e["wd"] + 180) % 360
    freq = np.bincount(sector(toward[op]), minlength=SECT).astype(float)
    freq /= freq.sum()
    allh = (yr >= 2009) & np.isfinite(e["ws"])
    freq_all = np.bincount(sector(toward[allh & (e["ws"] >= 1)]), minlength=SECT).astype(float)
    freq_all /= freq_all.sum()
    mon = e["t"].astype("datetime64[M]").astype(int) % 12 + 1
    res["wind"] = dict(hours=int(allh.sum()), dust_hours=int(op.sum()), dust_share=float(op.sum() / allh.sum()),
                       dust_hours_by_month=[int((op & (mon == m)).sum()) for m in range(1, 13)],
                       toward_freq_dust=freq.tolist(), toward_freq_all=freq_all.tolist(),
                       mean_ws=float(np.nanmean(e["ws"][allh])), p95_ws=float(np.nanpercentile(e["ws"][allh], 95)))
    # downwind: the 3 adjacent sectors that receive the most dust-hour transport; upwind: the opposite 3 sectors
    win = [sum(freq[(k + j) % SECT] for j in range(3)) for k in range(SECT)]
    k0 = int(np.argmax(win))
    D = [(k0 + j) % SECT for j in range(3)]
    U = [(s_ + SECT // 2) % SECT for s_ in D]
    res["downwind_share_of_dust_transport"] = float(win[k0])
    res["upwind_share_of_dust_transport"] = float(sum(freq[s_] for s_ in U))
    res["downwind_sectors"], res["upwind_sectors"] = D, U
    tr = trajectories(e, op, hours=(1, 3, 6))
    np.savez_compressed(os.path.join(RES_DIR, "traj.npz"), **{f"dx{h}": tr[h][0] for h in tr}, **{f"dy{h}": tr[h][1] for h in tr})

    # --- zone profiles and surface DiD (step 4, surfaces)
    def zmeans(ix, key):
        out = np.full((len(RINGS) - 1, SECT), np.nan)
        for i in range(len(RINGS) - 1):
            ring = valid & (dist >= RINGS[i]) & (dist < RINGS[i + 1]) & np.isfinite(ix[key])
            for s in range(SECT):
                v = ix[key][ring & (sec == s)]
                if v.size >= 30:
                    out[i, s] = float(np.mean(v))
        return out

    prof = {}
    for src, coll in (("landsat", land), ("s2", s2)):
        for tag, ix in coll.items():
            for key in ("FCD", "VIS", "NDVI"):
                prof[f"{src}_{tag}_{key}"] = zmeans(ix, key).tolist()
    res["profiles"] = dict(rings=RINGS, data=prof)

    def ydu(ix, key, d_sec, u_sec):
        near = valid & (dist >= NEAR[0]) & (dist < NEAR[1]) & np.isfinite(ix[key])
        yd = float(np.mean(ix[key][near & np.isin(sec, d_sec)]))
        yu = float(np.mean(ix[key][near & np.isin(sec, u_sec)]))
        return yd, yu

    def did(H, L, key, d_sec, u_sec):
        ydh, yuh = ydu(H, key, d_sec, u_sec)
        ydl, yul = ydu(L, key, d_sec, u_sec)
        return dict(Y_DH=ydh, Y_UH=yuh, Y_DL=ydl, Y_UL=yul, delta=(ydh - yuh) - (ydl - yul))

    surf = {}
    pairs = [("landsat 2023-2025 vs 2006-2008 (before mining)", land["2023_2025"], land["2006_2008"])]
    if "2023" in s2 and "2022" in s2:
        pairs.append(("sentinel-2 2023 (high output) vs 2022 (low output)", s2["2023"], s2["2022"]))
    for name, H, L in pairs:
        for key in ("FCD", "VIS"):
            r = did(H, L, key, D, U)
            # randomisation check: the same contrast for every rotation of the sector pair
            rot = []
            for k in range(SECT):
                dd = [(s + k) % SECT for s in D]
                uu = [(s + k) % SECT for s in U]
                rot.append(did(H, L, key, dd, uu)["delta"])
            rot = np.array(rot)
            r["rotations"] = rot.tolist()
            r["rank_of_observed"] = int((np.abs(rot) >= abs(r["delta"]) - 1e-12).sum())
            r["p_rotation"] = r["rank_of_observed"] / SECT
            surf[f"{name} | {key}"] = r
    # DiD by distance ring, each with its own rotation check (Landsat, FCD and VIS)
    by_ring = {}
    H_, L_ = land["2023_2025"], land["2006_2008"]
    for key in ("FCD", "VIS"):
        rows = []
        for i in range(2, len(RINGS) - 1):   # from 500 m outward
            r0, r1 = RINGS[i], RINGS[i + 1]
            def dd(ix, ds, us):
                near = valid & (dist >= r0) & (dist < r1) & np.isfinite(ix[key])
                return float(np.mean(ix[key][near & np.isin(sec, ds)]) - np.mean(ix[key][near & np.isin(sec, us)]))
            rot = []
            for k in range(SECT):
                ds = [(s_ + k) % SECT for s_ in D]; us = [(s_ + k) % SECT for s_ in U]
                rot.append(dd(H_, ds, us) - dd(L_, ds, us))
            rot = np.array(rot)
            rank = int((np.abs(rot) >= abs(rot[0]) - 1e-12).sum())
            rows.append(dict(r0=r0, r1=r1, delta=float(rot[0]), rank=rank, p_rotation=rank / SECT))
        by_ring[key] = rows
    surf["by_ring_landsat"] = by_ring

    # per-sector change vs transport frequency (Spearman)
    from scipy.stats import spearmanr
    ch = []
    for s in range(SECT):
        near = valid & (dist >= NEAR[0]) & (dist < NEAR[1]) & (sec == s)
        a = land["2023_2025"]["FCD"][near]; b = land["2006_2008"]["FCD"][near]
        ch.append(float(np.nanmean(a) - np.nanmean(b)))
    rho, p = spearmanr(freq, ch)
    surf["sector_change_vs_transport"] = dict(change=ch, rho=float(rho), p=float(p))
    res["surface_did"] = surf

    # affected area: FCD >= 0.3 outside the footprint, by period
    # newly coal-like surface outside the footprint: FCD rose by >= 0.2 since 2006-2008 and is now >= 0.3
    aff = {}
    base = land["2006_2008"]["FCD"]
    for tag in ("2010_2011", "2014_2016", "2019_2021", "2023_2025"):
        f_ = land[tag]["FCD"]
        m = valid & (f_ >= 0.3) & ((f_ - base) >= 0.2)
        by_ring = [float((m & (dist >= RINGS[i]) & (dist < RINGS[i + 1])).sum() * R * R / 1e6) for i in range(len(RINGS) - 1)]
        aff[tag] = dict(km2_0_10km=float((m & (dist < 10000)).sum() * R * R / 1e6),
                        km2_down=float((m & (dist < 10000) & np.isin(sec, D)).sum() * R * R / 1e6),
                        km2_up=float((m & (dist < 10000) & np.isin(sec, U)).sum() * R * R / 1e6),
                        km2_by_ring=by_ring,
                        km2_by_sector=[float((m & (dist < 10000) & (sec == k)).sum() * R * R / 1e6) for k in range(SECT)])
    res["new_coal_like_area"] = aff

    np.savez_compressed(os.path.join(RES_DIR, "maps.npz"), fp=fp, dist=dist.astype(np.float32), sec=sec.astype(np.int8), valid=valid,
                        fcd_post=land["2023_2025"]["FCD"].astype(np.float32), fcd_pre=land["2006_2008"]["FCD"].astype(np.float32),
                        dvis=dvis.astype(np.float32), coal=coal_recent,
                        fcd_s2_2024=s2.get("2024", land["2023_2025"])["FCD"].astype(np.float32))

    # --- AOD (step 4, air)
    days, aod = maiac()
    if aod is not None:
        m = G["maiac"]
        mx = m["x0"] + (np.arange(m["n"]) + 0.5) * m["res"]
        my = m["y0"] - (np.arange(m["n"]) + 0.5) * m["res"]
        MX, MY = np.meshgrid(mx, my)
        # footprint fraction per 1 km cell
        ci = ((XX - m["x0"]) // m["res"]).astype(int); cj = ((m["y0"] - YY) // m["res"]).astype(int)
        frac = np.zeros((m["n"], m["n"])); cnt = np.zeros((m["n"], m["n"]))
        ok = (ci >= 0) & (ci < m["n"]) & (cj >= 0) & (cj < m["n"])
        np.add.at(frac, (cj[ok], ci[ok]), fp[ok].astype(float)); np.add.at(cnt, (cj[ok], ci[ok]), 1)
        frac = np.where(cnt > 0, frac / np.maximum(cnt, 1), 0)
        fp1 = frac >= 0.25
        d1 = ndimage.distance_transform_edt(~fp1) * m["res"]
        b1 = bearing(MX - centre[0], MY - centre[1])
        ring1 = (~fp1) & (d1 >= 1000) & (d1 <= 10000)
        ring_near = (~fp1) & (d1 >= 1000) & (d1 <= 5000)
        dbins = [1000, 3000, 5000, 7500, 10000, 15000]
        far1 = (~fp1) & (d1 >= 15000)
        # wind at the overpass hours (03-06 UTC)
        hr = e["t"].astype("datetime64[h]").astype(int) % 24
        dkey = e["t"].astype("datetime64[D]").astype(str)
        sel = (hr >= 3) & (hr <= 6)
        U_, V_, W_ = {}, {}, {}
        for dk, uu, vv, ww in zip(dkey[sel], e["u"][sel], e["v"][sel], e["ws"][sel]):
            U_.setdefault(dk, []).append(uu); V_.setdefault(dk, []).append(vv); W_.setdefault(dk, []).append(ww)
        merra = load_daily_csv("merra2_dust_daily_*.csv", ["dusmass_uhg_ugm3", "dusmass_gobi_ugm3"])
        recs = []
        for k, dk in enumerate(days):
            a = aod[k]
            if dk not in U_ or not np.isfinite(a).any():
                continue
            u, v = np.mean(U_[dk]), np.mean(V_[dk])
            sp = float(np.hypot(u, v))
            if sp < 2:
                continue
            tw = (np.degrees(np.arctan2(u, v)) + 360) % 360
            dd = np.abs((b1 - tw + 180) % 360 - 180)
            du_ = np.abs((b1 - tw) % 360 - 180)
            down = ring1 & (dd <= 45) & np.isfinite(a)
            up = ring1 & (du_ <= 45) & np.isfinite(a)
            if down.sum() < 3 or up.sum() < 3:
                continue
            dn_near = ring_near & (dd <= 45) & np.isfinite(a)
            up_near = ring_near & (du_ <= 45) & np.isfinite(a)
            prof_d = [float(np.mean(a[(~fp1) & (d1 >= dbins[i]) & (d1 < dbins[i + 1]) & (dd <= 45) & np.isfinite(a)])) if ((~fp1) & (d1 >= dbins[i]) & (d1 < dbins[i + 1]) & (dd <= 45) & np.isfinite(a)).sum() >= 2 else np.nan for i in range(len(dbins) - 1)]
            prof_u = [float(np.mean(a[(~fp1) & (d1 >= dbins[i]) & (d1 < dbins[i + 1]) & (du_ <= 45) & np.isfinite(a)])) if ((~fp1) & (d1 >= dbins[i]) & (d1 < dbins[i + 1]) & (du_ <= 45) & np.isfinite(a)).sum() >= 2 else np.nan for i in range(len(dbins) - 1)]
            rec = dict(day=dk, down=float(np.mean(a[down])), up=float(np.mean(a[up])), ws=sp, toward=float(tw),
                       d_near=(float(np.mean(a[dn_near]) - np.mean(a[up_near])) if dn_near.sum() >= 2 and up_near.sum() >= 2 else np.nan),
                       prof_d=prof_d, prof_u=prof_u,
                       far=float(np.nanmean(a[far1])) if np.isfinite(a[far1]).any() else np.nan,
                       merra_uhg=merra.get(dk, [np.nan, np.nan])[0], merra_gobi=merra.get(dk, [np.nan, np.nan])[1])
            rec["d"] = rec["down"] - rec["up"]
            recs.append(rec)
        res["aod_n_days"] = len(recs)
        json.dump(recs, open(os.path.join(RES_DIR, "aod_days.json"), "w"))
        arr = lambda k: np.array([r[k] for r in recs], float)
        dd_, dy = arr("d"), np.array([r["day"] for r in recs])
        yrs = np.array([int(x[:4]) for x in dy])
        mons = np.array([int(x[5:7]) for x in dy])
        mu = arr("merra_uhg"); wsv = arr("ws")
        q50, q90 = np.nanpercentile(mu, 50), np.nanpercentile(mu, 90)
        def summ(mask):
            x = dd_[mask]
            lo, hi = boot_ci(x)
            return dict(n=int(np.isfinite(x).sum()), mean=float(np.nanmean(x)) if x.size else np.nan, ci=[lo, hi],
                        down=float(np.nanmean(arr("down")[mask])) if mask.any() else np.nan,
                        up=float(np.nanmean(arr("up")[mask])) if mask.any() else np.nan)
        pre_m, post_m = yrs <= 2008, yrs >= 2017
        l22 = (yrs == 2022) & (mons <= 6); h23 = (yrs == 2023) & (mons <= 6)
        groups = {
            "pre 2002-2008": pre_m, "post 2017-2025": post_m,
            "2022 Jan-Jun (low output)": l22, "2023 Jan-Jun (high output)": h23,
            "pre, low natural dust": pre_m & (mu < q50), "post, low natural dust": post_m & (mu < q50),
            "pre, high natural dust": pre_m & (mu >= q90), "post, high natural dust": post_m & (mu >= q90),
            "pre, wind>=6": pre_m & (wsv >= THR_WIND), "post, wind>=6": post_m & (wsv >= THR_WIND),
        }
        out = {k: summ(v) for k, v in groups.items()}
        def did_aod(h, l):
            a, b = dd_[h], dd_[l]
            a, b = a[np.isfinite(a)], b[np.isfinite(b)]
            bs = RNG.choice(a, (2000, a.size)).mean(1) - RNG.choice(b, (2000, b.size)).mean(1)
            return dict(delta=float(a.mean() - b.mean()), ci=np.percentile(bs, [2.5, 97.5]).tolist(), nH=int(a.size), nL=int(b.size))
        out["DiD post vs pre"] = did_aod(post_m, pre_m)
        out["DiD 2023H1 vs 2022H1"] = did_aod(h23, l22)
        out["DiD post vs pre | low natural dust"] = did_aod(post_m & (mu < q50), pre_m & (mu < q50))
        out["DiD post vs pre | high natural dust"] = did_aod(post_m & (mu >= q90), pre_m & (mu >= q90))
        out["DiD post vs pre | wind>=6"] = did_aod(post_m & (wsv >= THR_WIND), pre_m & (wsv >= THR_WIND))
        out["merra_thresholds"] = dict(q50=float(q50), q90=float(q90))
        dn = arr("d_near")
        def did_near(h, l):
            a, b = dn[h], dn[l]
            a, b = a[np.isfinite(a)], b[np.isfinite(b)]
            bs = RNG.choice(a, (2000, a.size)).mean(1) - RNG.choice(b, (2000, b.size)).mean(1)
            return dict(delta=float(a.mean() - b.mean()), ci=np.percentile(bs, [2.5, 97.5]).tolist(), nH=int(a.size), nL=int(b.size))
        out["DiD post vs pre | ring 1-5 km"] = did_near(post_m, pre_m)
        pd_ = np.array([r["prof_d"] for r in recs], float); pu_ = np.array([r["prof_u"] for r in recs], float)
        out["profile"] = dict(dbins=dbins, pre_down=np.nanmean(pd_[pre_m], 0).tolist(), pre_up=np.nanmean(pu_[pre_m], 0).tolist(),
                              post_down=np.nanmean(pd_[post_m], 0).tolist(), post_up=np.nanmean(pu_[post_m], 0).tolist())
        out["mean_aod_pre_post_far"] = [float(np.nanmean(arr("far")[pre_m])), float(np.nanmean(arr("far")[post_m]))]
        res["aod"] = out

    # --- natural dust periods (step 3)
    merra = load_daily_csv("merra2_dust_daily_*.csv", ["dusmass_uhg_ugm3", "dusmass_gobi_ugm3"])
    aai = load_daily_csv("s5p_aai_daily.csv", ["aai_20km", "aai_box"])
    ks = sorted(merra)
    mv = np.array([merra[k][0] for k in ks])
    mm = np.array([int(k[5:7]) for k in ks]); my_ = np.array([int(k[:4]) for k in ks])
    q90 = np.nanpercentile(mv, 90)
    nat = dict(q50=float(np.nanpercentile(mv, 50)), q90=float(q90), q99=float(np.nanpercentile(mv, 99)),
               monthly_mean=[float(np.nanmean(mv[mm == m])) for m in range(1, 13)],
               high_days_by_month=[int(((mv >= q90) & (mm == m)).sum()) for m in range(1, 13)],
               high_days_by_year={int(y): int(((mv >= q90) & (my_ == y)).sum()) for y in sorted(set(my_))},
               spring_mean_by_year={int(y): float(np.nanmean(mv[(my_ == y) & (mm >= 3) & (mm <= 5)])) for y in sorted(set(my_))},
               top10=[(ks[i], float(mv[i])) for i in np.argsort(-np.nan_to_num(mv))[:10]])
    common = [k for k in ks if k in aai and np.isfinite(aai[k][0]) and np.isfinite(merra[k][0])]
    if common:
        from scipy.stats import spearmanr
        r_, p_ = spearmanr([merra[k][0] for k in common], [aai[k][0] for k in common])
        nat["merra_vs_aai_spearman"] = dict(rho=float(r_), p=float(p_), n=len(common))
    res["natural_dust"] = nat

    save_json("results.json", res)
    print(json.dumps({k: v for k, v in res.items() if k not in ("profiles",)}, indent=1, default=float)[:6000])


if __name__ == "__main__":
    run()
