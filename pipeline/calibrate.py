"""Fit each hazard to satellite observations and measure the error on years the model has never seen.

A weather index alone says little here: raw FWI is highest in the Gobi, where there is almost nothing to burn. So the
score is the probability of the event given weather, land and fuel, fitted to what satellites actually recorded:

    wildfire  P(MODIS active fire in the cell that day | FWI, Mongolian multi-criteria susceptibility, greenness)
    dust      P(TROPOMI absorbing aerosol index anomaly >= 1 | wind, soil moisture, dry vegetation, bare ground), March-May

Score scale, the same for both, in powers of 4 of the lift over the national average rate:
    lift   < 1/4   1/4-1    1-4     4-16    > 16
    class  v.low   low      mod.    high    v.high
    score  0-20    20-40    40-60   60-80   80-100

Years are split in time, never at random: neighbouring days are nearly copies of each other, and a random split would
report skill the model does not have. Coefficients for production are refitted on all years after the test.

Flood has too few recorded events to fit, so it uses per-cell return periods instead (see flood_score) and is only
checked against the Global Flood Database.

    python calibrate.py prep | fire | dust | flood
"""
import datetime as dt
import json
import os
import sys

import numpy as np

import common as C
import fwi_np as F
import load as L
import refit_features as R
from fetch_era5 import CACHE

HERE = os.path.dirname(__file__)
MODEL = os.path.join(HERE, "model.json")
YEARS = list(range(2001, 2026))
FIRE_TRAIN, FIRE_TEST = range(2001, 2018), range(2018, 2026)
DUST_TRAIN, DUST_TEST = range(2019, 2024), range(2024, 2027)
SNOW_CM = 1.0
REFIT = '--refit' in sys.argv
DUST_MONTHS = tuple(range(1, 13)) if REFIT else (3, 4, 5)
AAI_EVENT = 1.0
rng = np.random.default_rng(20261106)


def save_heldout(hazard, beta, base, verification, method, **arrays):
    """Optional reproducibility artifacts: training-only parameters, not production fits."""
    folder = os.environ.get('HAZARD_REPORT_DIR')
    if folder:
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, f'heldout_{hazard}.json'), 'w', encoding='utf-8') as out:
            json.dump(dict(beta=beta.tolist(), base=base, verification=verification, method=method), out, indent=2)
        if arrays:
            np.savez_compressed(os.path.join(folder, f'heldout_{hazard}.npz'), **arrays)


def lift_score(p, base):
    return np.clip(20.0 * (np.log(np.maximum(p, 1e-12) / base) / np.log(4.0) + 2.0), 0.0, 100.0)


def save_model(section, value):
    m = json.load(open(MODEL, encoding="utf-8")) if os.path.exists(MODEL) else {}
    m[section] = value
    json.dump(m, open(MODEL, "w", encoding="utf-8"), indent=1)


def logistic_fit(X, y, w, ridge=1e-4, iters=40):
    """Weighted logistic regression by iteratively reweighted least squares. X includes the intercept column."""
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        z = np.clip(X @ b, -30, 30)
        p = 1 / (1 + np.exp(-z))
        s = w * np.maximum(p * (1 - p), 1e-9)
        H = (X * s[:, None]).T @ X + ridge * np.eye(X.shape[1])
        step = np.linalg.solve(H, X.T @ (w * (y - p)) - ridge * b)
        b += step
        if np.abs(step).max() < 1e-7:
            break
    return b


def predict(X, b):
    return 1 / (1 + np.exp(-np.clip(X @ b, -30, 30)))


def auc_from_hist(pos, neg):
    """ROC area from score histograms, ties counted half."""
    n_pos, n_neg = pos.sum(), neg.sum()
    if n_pos == 0 or n_neg == 0:
        return np.nan
    below = np.cumsum(neg) - neg
    return float((pos * (below + neg / 2)).sum() / (n_pos * n_neg))


def verify(hist_pos, hist_neg, base, label):
    """hist_* are [years, 101] counts of integer scores on test years. Negatives are already rescaled to true counts."""
    pos, neg = hist_pos.sum(0), hist_neg.sum(0)
    auc = auc_from_hist(pos, neg)
    boot = []
    n = hist_pos.shape[0]
    for _ in range(1000):  # whole years are resampled, because days within a year are not independent
        k = rng.integers(0, n, n)
        boot.append(auc_from_hist(hist_pos[k].sum(0), hist_neg[k].sum(0)))
    lo, hi = np.nanpercentile(boot, [2.5, 97.5])
    hits, misses, false = pos[60:].sum(), pos[:60].sum(), neg[60:].sum()
    pod, far = hits / max(hits + misses, 1), false / max(hits + false, 1)
    csi = hits / max(hits + misses + false, 1)
    # Brier on the class-wise event rate, and the reliability gap in score units = model uncertainty.
    centres, gaps, wts = np.arange(5, 100, 10), [], []
    brier_num = 0.0
    for a in range(0, 100, 10):
        p, q = pos[a:a + 10 if a < 90 else 101].sum(), neg[a:a + 10 if a < 90 else 101].sum()
        if p + q == 0:
            continue
        rate = p / (p + q)
        pred = base * 4.0 ** ((a + 5) / 20.0 - 2.0)
        brier_num += p * (1 - pred) ** 2 + q * pred ** 2
        if p >= 20:
            gaps.append(float(lift_score(rate, base)) - (a + 5))
    u_model = float(np.sqrt(np.mean(np.square(gaps)))) if gaps else None
    out = dict(reference=label, n=int(pos.sum()), auc=round(auc, 3), auc_ci=[round(float(lo), 3), round(float(hi), 3)], pod=round(float(pod), 3), far=round(float(far), 3), csi=round(float(csi), 3),
               brier=round(float(brier_num / (pos.sum() + neg.sum())), 5), share_flagged=round(float((pos[60:].sum() + neg[60:].sum()) / (pos.sum() + neg.sum())), 4))
    return out, u_model, gaps


# ------------------------------------------------------------------ shared
def prep():
    """One pass over the years: FWI, monthly rain, fire detection totals."""
    os.makedirs(os.path.join(CACHE, "fwi"), exist_ok=True)
    years = YEARS + [2026]
    rain = np.full((len(years), 12, C.NY, C.NX), np.nan, np.float32)
    for k, y in enumerate(years):
        e, dates = L.era5_year(y)
        if not dates:
            continue
        p = os.path.join(CACHE, "fwi", f"{y}.npy")
        if not os.path.exists(p) or np.load(p, mmap_mode="r").shape[0] != len(dates):
            np.save(p, L.fwi_year(e, dates).astype(np.float16))
        r0 = L.noon_rain(e)
        mon = np.array([d.month for d in dates])
        for m in range(1, 13):
            if (mon == m).sum() >= 28:
                rain[k, m - 1] = r0[mon == m].sum(0)
        print(y, len(dates), flush=True)
    np.save(os.path.join(CACHE, "monthly_rain.npy"), rain)


def mongolia():
    s = L.static()
    return s, s["mask"] >= 0.5


def class_score(v, ok):
    """Five classes: 1 for zero, then quartiles of the positive values, as ranked classes in Nasanbat et al."""
    out = np.ones(v.shape, np.float32)
    pos = v[ok & (v > 0)]
    if pos.size:
        q = np.quantile(pos, [0.25, 0.5, 0.75])
        out = np.where(v > 0, 2 + (v > q[0]) + (v > q[1]) + (v > q[2]), 1).astype(np.float32)
    return out


LC_RANK = dict(lc_forest=5, lc_savanna=5, lc_grass=4, lc_shrub=3, lc_crop=2, lc_wet=2, lc_urban=1, lc_barren=1, lc_water=1, lc_snow=1)
W_BURN, W_HOT, W_LC, W_SPI = 6 / 21, 5 / 21, 4 / 21, 2 / 21  # Nasanbat et al. (2018) rank-sum weights; two criteria have no open data


def susceptibility(s, ok, years, hot):
    """Static part of the multi-criteria score from the given training years only, so test years stay unseen."""
    idx = [list(s["burn_years"]).index(y) for y in years if y in s["burn_years"]]
    burn = class_score(s["burn"][idx].mean(0), ok)
    hots = class_score(hot, ok)
    total = sum(s[k] for k in LC_RANK)
    lc = sum(s[k] * v for k, v in LC_RANK.items()) / np.maximum(total, 1e-6)
    return W_BURN * burn + W_HOT * hots + W_LC * lc, W_BURN + W_HOT + W_LC


def spi_class(z):
    return np.where(z <= -1.5, 5, np.where(z <= -1.0, 4, np.where(z <= 0.0, 3, np.where(z <= 1.0, 2, 1)))).astype(np.float32)


def monthly_spi(train_idx):
    r = np.load(os.path.join(CACHE, "monthly_rain.npy"))
    if REFIT:
        return dict(rain=r, **R.gamma_fit(r[train_idx]))
    mu, sd = np.nanmean(r[train_idx], 0), np.nanstd(r[train_idx], 0)
    return r, mu, np.maximum(sd, 1.0)


# -------------------------------------------------------------------- fire
def fire_counts(years):
    tot = np.zeros((C.NY, C.NX), np.float64)
    for y in years:
        _, dates = L.era5_year(y)
        tot += (L.obs_year("fire", y, dates) > 0).sum(0)
    return tot / len(list(years))


def fire_features(y, ok, s_static, s_weight, spi, ndvi_prev_fn):
    """Per-day feature arrays for one year, on Mongolian cells. Returns dates, snow flag and features [days, cells, k]."""
    e, dates = L.era5_year(y)
    f = np.load(os.path.join(CACHE, "fwi", f"{y}.npy")).astype(np.float32)[:len(dates)]
    fs = F.effis_score(f)[:, ok] / 100.0
    snow = e["sd"][:, ok] >= SNOW_CM
    if isinstance(spi, dict):
        r = spi['rain']
    else:
        r, mu, sd = spi
    yi = y - 2001
    S = np.empty(fs.shape, np.float32)
    G = np.empty(fs.shape, np.float32)
    months = np.array([d.month for d in dates])
    for m in range(1, 13):
        i = months == m
        if not i.any():
            continue
        if isinstance(spi, dict):
            # A completed previous month is available to the daily forecast.
            py, pm = yi - (m == 1), (m - 2) % 12
            z = R.gamma_spi(r[py, pm], spi['spi_shape'][pm], spi['spi_scale'][pm], spi['spi_q'][pm]) if py >= 0 else np.full(s_static.shape, np.nan)
        else:
            z = (r[yi, m - 1] - mu[m - 1]) / sd[m - 1]
        z = np.where(np.isfinite(z), z, 0.0)
        S[i] = ((s_static + W_SPI * spi_class(z)) / (s_weight + W_SPI))[ok] / 5.0
        G[i] = ndvi_prev_fn(y, m)[ok]
    return dates, snow, fs, S, np.nan_to_num(G, nan=0.1)


def ndvi_prev(y, m):
    """Greenness of the month before: the current month is not complete yet in near real time."""
    return L.veg(y - (m == 1), 12 if m == 1 else m - 1)[0]


def fire_design(fs, S, G, year=None, time_cap=2025):
    columns = [np.ones(fs.size), fs.ravel(), S.ravel(), G.ravel(), fs.ravel() * S.ravel(), fs.ravel() * G.ravel()]
    if year is not None:
        columns.append(np.broadcast_to(R.time_term(year, time_cap), fs.shape).ravel())
    return np.column_stack(columns)


def fire_collect(years, ok, s_static, s_weight, spi, neg_rate):
    Xp, Xn, n_snow_pos, total_cells, total_pos = [], [], 0, 0, 0
    for y in years:
        dates, snow, fs, S, G = fire_features(y, ok, s_static, s_weight, spi, ndvi_prev)
        obs = L.obs_year("fire", y, dates)[:, ok]
        hit = (obs > 0) & np.isfinite(obs)
        observed = np.isfinite(obs) if REFIT else np.ones(hit.shape, bool)
        total_cells += int(observed.sum())
        total_pos += int(hit.sum())
        n_snow_pos += int((hit & snow).sum())
        free = ~snow & observed
        p = hit & free
        n = free & ~hit & (rng.random(hit.shape) < neg_rate)
        Xp.append(np.column_stack([fs[p], S[p], G[p]] + ([np.full(p.sum(), y)] if REFIT else [])))
        Xn.append(np.column_stack([fs[n], S[n], G[n]] + ([np.full(n.sum(), y)] if REFIT else [])))
        print(y, "fires", int(hit.sum()), "on snow", int((hit & snow).sum()), flush=True)
    return np.concatenate(Xp), np.concatenate(Xn), total_pos / total_cells, n_snow_pos


def design3(a, time_cap=2025):
    return fire_design(a[:, 0], a[:, 1], a[:, 2], a[:, 3] if a.shape[1] == 4 else None, time_cap)


def fire():
    s, ok = mongolia()
    neg_rate = 0.01
    print("cells in Mongolia", int(ok.sum()))
    train_idx = [y - 2001 for y in FIRE_TRAIN]
    spi = monthly_spi(train_idx)
    hot = fire_counts(FIRE_TRAIN)
    S0, w0 = susceptibility(s, ok, FIRE_TRAIN, hot)
    Xp, Xn, base, _ = fire_collect(FIRE_TRAIN, ok, S0, w0, spi, neg_rate)
    print("train positives", len(Xp), "negatives kept", len(Xn), "base rate", base)
    Xall = np.vstack([Xp, Xn])
    yv = np.r_[np.ones(len(Xp)), np.zeros(len(Xn))]
    wv = np.r_[np.ones(len(Xp)), np.full(len(Xn), 1 / neg_rate)]
    b = logistic_fit(design3(Xall, FIRE_TRAIN[-1]), yv, wv)
    print("coefficients", b.round(3))

    # Held-out years. Compare against simpler models to see what each ingredient adds.
    test = {}
    hp, hn = [], []
    checks = R.ProbabilityCheck()
    alt = dict(fwi=([], []), s=([], []))
    for y in FIRE_TEST:
        dates, snow, fs, S, G = fire_features(y, ok, S0, w0, spi, ndvi_prev)
        obs = L.obs_year("fire", y, dates)[:, ok]
        hit = (obs > 0) & np.isfinite(obs)
        P = predict(fire_design(fs, S, G, y if REFIT else None, FIRE_TRAIN[-1]), b).reshape(fs.shape)
        observed = np.isfinite(obs) if REFIT else np.ones(hit.shape, bool)
        checks.add(y, np.where(snow, 0.0, P), hit, observed)
        sc = np.rint(lift_score(P, base)).astype(int)
        sc[snow] = 0
        hp.append(np.bincount(sc[hit], minlength=101))
        hn.append(np.bincount(sc[observed & ~hit], minlength=101))
        a = np.rint(fs * 100).astype(int)
        a[snow] = 0
        alt["fwi"][0].append(np.bincount(a[hit], minlength=101))
        alt["fwi"][1].append(np.bincount(a[~hit], minlength=101))
        a = np.rint(S * 100).astype(int)
        alt["s"][0].append(np.bincount(a[hit], minlength=101))
        alt["s"][1].append(np.bincount(a[~hit], minlength=101))
    hp, hn = np.array(hp), np.array(hn)
    v, u_model, gaps = verify(hp, hn, base, "MODIS FIRMS")
    v["period"] = f"{FIRE_TEST[0]}-{FIRE_TEST[-1]}"
    v.update(checks.result(base))
    v['reliability_gaps_score'] = gaps
    v["auc_fwi_only"] = round(auc_from_hist(np.array(alt["fwi"][0]).sum(0), np.array(alt["fwi"][1]).sum(0)), 3)
    v["auc_mce_only"] = round(auc_from_hist(np.array(alt["s"][0]).sum(0), np.array(alt["s"][1]).sum(0)), 3)
    print(json.dumps(v, indent=1), "u_model", u_model, "gaps", np.round(gaps, 1))

    # Production: same model, refitted on every year.
    test_spi = {k: a for k, a in spi.items() if k.startswith('spi_')} if REFIT else dict(spi_mu=spi[1], spi_sd=spi[2])
    save_heldout('fire', b, base, v, dict(version='fire-refit-v1' if REFIT else 'legacy', time_cap=FIRE_TRAIN[-1]), S=S0, w=w0, **test_spi)
    all_idx = list(range(len(YEARS)))
    spi = monthly_spi(all_idx)
    hot = fire_counts(YEARS)
    S1, w1 = susceptibility(s, ok, YEARS, hot)
    Xp, Xn, base1, _ = fire_collect(YEARS, ok, S1, w1, spi, neg_rate)
    Xall = np.vstack([Xp, Xn])
    b1 = logistic_fit(design3(Xall), np.r_[np.ones(len(Xp)), np.zeros(len(Xn))], np.r_[np.ones(len(Xp)), np.full(len(Xn), 1 / neg_rate)])
    params = {k: a.astype(np.float32) for k, a in spi.items() if k.startswith('spi_')} if REFIT else dict(spi_mu=spi[1].astype(np.float32), spi_sd=spi[2].astype(np.float32))
    np.savez_compressed(os.path.join(HERE, "model_fire.npz"), S=S1.astype(np.float32), w=w1, **params)
    method = dict(version='fire-refit-v1', time_cap=YEARS[-1], test_time_cap=FIRE_TRAIN[-1], spi='zero-adjusted-gamma', spi_lag_months=1, spi_reference='2001-2025', spi_reference_years=25) if REFIT else dict(version='legacy')
    save_model("fire", dict(beta=b1.tolist(), base=base1, verification=v, u_model=u_model, beta_test_split=b.tolist(), method=method))


# -------------------------------------------------------------------- dust
def dust_features(y, ok, s):
    """Rows for March-May of a year: wind, soil water, greenness, dry vegetation, bare share."""
    e, dates = L.era5_year(y)
    months = np.array([d.month for d in dates])
    keep = np.isin(months, DUST_MONTHS)
    if not keep.any():
        return None
    d2 = [d for d, k in zip(dates, keep) if k]
    w, sm, sd = e["wmax"][keep][:, ok], e["sm"][keep][:, ok], e["sd"][keep][:, ok]
    N = np.empty(w.shape, np.float32)
    T = np.empty(w.shape, np.float32)
    for m in DUST_MONTHS:
        i = months[keep] == m
        if i.any():
            n, t = L.veg(y - (m == 1), 12 if m == 1 else m - 1)
            N[i], T[i] = n[ok], t[ok]
    return d2, sd >= SNOW_CM, w, sm, np.nan_to_num(N, nan=0.1), np.nan_to_num(T, nan=1.2), np.broadcast_to(s["lc_barren"][ok], w.shape)


def dust_design(w, sm, n, t, bare, month=None):
    threshold = R.wind_threshold(bare) if month is not None else 6.0
    ex = np.maximum(w - threshold, 0.0)
    columns = [np.ones(w.size), w.ravel() / 10, ex.ravel() / 10, sm.ravel() * 5, n.ravel() * 3, t.ravel(), bare.ravel(), (ex * bare).ravel() / 10]
    if month is not None:
        columns += [np.broadcast_to(v, w.shape).ravel() for v in R.seasonal_terms(month)]
    return np.column_stack(columns)


def dust_collect(years, ok, s):
    D, Y, n_all, n_ev = [], [], 0, 0
    for y in years:
        f = dust_features(y, ok, s)
        if f is None:
            continue
        d2, snow, w, sm, N, T, B = f
        a = L.aai_anomaly(y, d2)[:, ok]
        seen = np.isfinite(a)
        ev = seen & (a >= AAI_EVENT)
        n_all += int(seen.sum())
        n_ev += int(ev.sum())
        keep = seen & ~snow & (ev | (rng.random(ev.shape) < 0.05))
        month = np.broadcast_to(np.array([d.month for d in d2])[:, None], w.shape)
        D.append(np.column_stack([w[keep], sm[keep], N[keep], T[keep], B[keep]] + ([month[keep]] if REFIT else [])))
        Y.append(ev[keep].astype(float))
        print(y, "valid", int(seen.sum()), "events", int(ev.sum()), flush=True)
    return np.concatenate(D), np.concatenate(Y), n_ev / max(n_all, 1)


def dust():
    s, ok = mongolia()
    D, Y, base = dust_collect(DUST_TRAIN, ok, s)
    wts = np.where(Y > 0, 1.0, 20.0)
    b = logistic_fit(dust_design(*D.T), Y, wts)
    print("train rows", len(Y), "base", base, "coef", b.round(3))
    hp, hn, wind_p, wind_n = [], [], [], []
    checks = R.ProbabilityCheck()
    seasonal = {name: ([], []) for name in ['DJF', 'MAM', 'JJA', 'SON']}
    for y in DUST_TEST:
        f = dust_features(y, ok, s)
        if f is None:
            continue
        d2, snow, w, sm, N, T, B = f
        a = L.aai_anomaly(y, d2)[:, ok]
        seen = np.isfinite(a)
        ev = seen & (a >= AAI_EVENT)
        month = np.broadcast_to(np.array([d.month for d in d2])[:, None], w.shape)
        P = predict(dust_design(w, sm, N, T, B, month if REFIT else None), b).reshape(w.shape)
        for mo in sorted(set(d.month for d in d2)):
            checks.add(f'{y}-{mo:02d}', np.where(snow, 0.0, P), ev, seen & (month == mo))
        sc = np.rint(lift_score(P, base)).astype(int)
        sc[snow] = 0
        hp.append(np.bincount(sc[ev], minlength=101))
        hn.append(np.bincount(sc[seen & ~ev], minlength=101))
        for name, months in [('DJF', [12, 1, 2]), ('MAM', [3, 4, 5]), ('JJA', [6, 7, 8]), ('SON', [9, 10, 11])]:
            season = np.isin(month, months)
            seasonal[name][0].append(np.bincount(sc[season & ev], minlength=101))
            seasonal[name][1].append(np.bincount(sc[season & seen & ~ev], minlength=101))
        ws = np.clip(np.rint(w * 4), 0, 100).astype(int)
        wind_p.append(np.bincount(ws[ev], minlength=101))
        wind_n.append(np.bincount(ws[seen & ~ev], minlength=101))
    hp, hn = np.array(hp), np.array(hn)
    v, u_model, gaps = verify(hp, hn, base, "Sentinel-5P TROPOMI AAI anomaly ≥ 1")
    v["period"] = f"{DUST_TEST[0]}-{DUST_TEST[-1]}, " + ('all available months (2026 through October)' if REFIT else '3-5 сар')
    v.update(checks.result(base))
    v['reliability_gaps_score'] = gaps
    v['seasons'] = {name: dict(auc=auc_from_hist(np.array(pos).sum(0), np.array(neg).sum(0)), events=int(np.sum(pos)), valid_cell_days=int(np.sum(pos) + np.sum(neg))) for name, (pos, neg) in seasonal.items() if np.sum(pos) and np.sum(neg)}
    v["auc_wind_only"] = round(auc_from_hist(np.array(wind_p).sum(0), np.array(wind_n).sum(0)), 3)
    print(json.dumps(v, indent=1), "u_model", u_model, "gaps", np.round(gaps, 1))
    save_heldout('dust', b, base, v, dict(version='dust-refit-v1' if REFIT else 'legacy', months=list(DUST_MONTHS)))
    D, Y, base1 = dust_collect(list(DUST_TRAIN) + list(DUST_TEST), ok, s)
    b1 = logistic_fit(dust_design(*D.T), Y, np.where(Y > 0, 1.0, 20.0))
    method = dict(version='dust-refit-v1', months=list(DUST_MONTHS), wind_threshold='9.8 - 0.9 * bare_fraction; experimental regional interpolation') if REFIT else dict(version='legacy', months=list(DUST_MONTHS))
    save_model("dust", dict(beta=b1.tolist(), base=base1, verification=v, u_model=u_model, aai_event=AAI_EVENT, method=method))


# ------------------------------------------------------------------- flood
def flood():
    """Return levels per cell, then the check against recorded floods. Twelve events cannot fit a model, only test one."""
    import scores as S
    s, ok = mongolia()
    am_sat, am_era = [], []
    for y in YEARS:
        e, dates = L.era5_year(y)
        rain = L.obs_year("rain", y, dates)
        w = S.flood_water(rain, e["melt0"])
        am_sat.append(w.max(0))
        day_era = np.zeros_like(rain)
        day_era[:-1] = e["tp0"][1:]
        am_era.append(S.flood_water(day_era, e["melt0"]).max(0))
        print(y, flush=True)
    mu, beta = S.gumbel_cells(np.array(am_sat))
    mu_e, beta_e = S.gumbel_cells(np.array(am_era))
    np.savez_compressed(os.path.join(HERE, "model_flood.npz"), mu=mu.astype(np.float32), beta=beta.astype(np.float32), mu_era=mu_e.astype(np.float32), beta_era=beta_e.astype(np.float32))

    g = np.load(os.path.join(CACHE, "gfd.npz"), allow_pickle=True)
    prone = S.prone_rank(s, s["mask"] > 0.02)
    pos, neg, rows = np.zeros(101), np.zeros(101), []
    for k in range(len(g["start"])):
        a, b = dt.date.fromisoformat(str(g["start"][k])), dt.date.fromisoformat(str(g["end"][k]))
        lo = a - dt.timedelta(days=3)
        e, dates = L.era5_year(a.year)
        rain = L.obs_year("rain", a.year, dates)
        sc = S.flood_score(S.flood_water(rain, e["melt0"]), mu, beta, prone)
        i = [n for n, d in enumerate(dates) if lo <= d <= b]
        if not i:
            continue
        peak = sc[i].max(0)
        wet = (g["share"][k] > 0) & ok
        if wet.sum() == 0:
            rows.append(dict(start=str(a), end=str(b), cause=str(g["cause"][k]), flooded_cells=0))
            continue
        v = np.rint(peak).astype(int)
        pos += np.bincount(v[wet], minlength=101)
        neg += np.bincount(v[ok & ~wet], minlength=101)
        rows.append(dict(start=str(a), end=str(b), cause=str(g["cause"][k]), flooded_cells=int(wet.sum()), peak_in_flood=round(float(peak[wet].max()), 1), share_high=round(float((peak[wet] >= 60).mean()), 3), share_high_elsewhere=round(float((peak[ok & ~wet] >= 60).mean()), 3)))
    used = [r for r in rows if r["flooded_cells"]]
    hit = sum(r["peak_in_flood"] >= 60 for r in used)
    v = dict(reference="Global Flood Database (MODIS)", period="2001-2018", n=len(used), auc=round(auc_from_hist(pos, neg), 3), events_hit=hit, events=rows)
    print(json.dumps(v, indent=1))
    save_model("flood", dict(verification=v))


# ---------------------------------------------------------- input uncertainty
def uinput():
    """Run every model a second time on independent inputs and measure how far the score moves.
    Two products with independent errors differ by sqrt(2) times the error of one, hence the division.
    Fire and dust: ERA5-Land against NOAA GFS with IMERG rain. Flood: IMERG against ERA5-Land rain."""
    import scores as S
    s, ok = mongolia()
    M = S.model()
    fm = dict(np.load(os.path.join(HERE, "model_fire.npz")))
    y = 2025
    e, dates = L.era5_year(y)
    i0 = [k for k, d in enumerate(dates) if dt.date(2025, 3, 1) <= d <= dt.date(2025, 10, 31)]
    a = np.concatenate([np.load(os.path.join(CACHE, "gfs", f"2025{m:02d}{h}.npy")) for m in range(3, 11) for h in "ab"], axis=1).astype(np.float32)
    T, RH, U, V, WM = a
    rain = L.obs_year("rain", y, dates)
    print("GFS minus ERA5-Land over Mongolia: T", float(np.nanmean(T[:, ok] - e["t"][i0][:, ok])), "sd", float(np.nanstd(T[:, ok] - e["t"][i0][:, ok])),
          "| wmax bias", float(np.nanmean(WM[:, ok] - e["wmax"][i0][:, ok])), "sd", float(np.nanstd(WM[:, ok] - e["wmax"][i0][:, ok])), flush=True)

    f_era = np.load(os.path.join(CACHE, "fwi", f"{y}.npy")).astype(np.float32)
    pre = {k: e[k][:i0[0]] for k in e}
    st = L.fwi_state(pre, dates[:i0[0]])
    W = np.hypot(U, V) * 3.6
    f_gfs = np.empty(T.shape, np.float32)
    for n, k in enumerate(i0):
        r0 = 0.79 * np.nan_to_num(rain[k - 1]) + 0.21 * np.nan_to_num(rain[k])
        st, f = F.step(st, np.nan_to_num(T[n]), np.nan_to_num(RH[n], nan=50.0), np.nan_to_num(W[n]), r0, dates[k].month)
        snow = e["sd"][k] >= SNOW_CM
        st = tuple(np.where(snow, v0, v) for v, v0 in zip(st, (F.FFMC0, F.DMC0, F.DC0)))
        f_gfs[n] = f
    sub = [dates[k] for k in i0]
    a1 = S.fire_year(y, sub, e["sd"][i0], f_era[i0], M, fm)
    a2 = S.fire_year(y, sub, e["sd"][i0], f_gfs, M, fm)
    tables = dict(fire=table(a1[:, ok], a2[:, ok]))

    d1 = S.dust_year(y, sub, {k: e[k][i0] for k in e}, s, M)
    e2 = {k: e[k][i0] for k in e}
    e2["wmax"] = WM
    d2 = S.dust_year(y, sub, e2, s, M)
    tables["dust"] = table(d1[:, ok], d2[:, ok])

    z = np.load(os.path.join(HERE, "model_flood.npz"))
    prone = S.prone_rank(s, s["mask"] > 0.02)
    day_era = np.zeros_like(rain)
    day_era[:-1] = e["tp0"][1:]
    w1 = S.flood_water(rain, e["melt0"])
    w2 = S.flood_water(day_era, e["melt0"])
    tables["flood"] = table(S.flood_score(w1, z["mu"], z["beta"], prone)[:, ok], S.flood_score(w2, z["mu_era"], z["beta_era"], prone)[:, ok])
    for h, v in tables.items():
        print(h, "u_input by score", v[::5], flush=True)
    save_model("u_input", tables)


def table(a, b, step=4):
    """Standard uncertainty at each score 0, 4, ... 100, from pairs of scores of one cell-day on two inputs."""
    a, b = a.ravel(), b.ravel()
    good = np.isfinite(a) & np.isfinite(b)
    a, b = a[good], b[good]
    m = (a + b) / 2
    d2 = (a - b) ** 2 / 2
    out = []
    for c in range(0, 101, step):
        i = np.abs(m - c) <= step
        out.append(round(float(np.sqrt(d2[i].mean())), 2) if i.sum() > 200 else None)
    good = [v for v in out if v is not None]
    filled = np.interp(range(len(out)), [k for k, v in enumerate(out) if v is not None], good)
    return [round(float(v), 2) for v in filled]


if __name__ == "__main__":
    dict(prep=prep, fire=fire, dust=dust, flood=flood, uinput=uinput)[sys.argv[1]]()
