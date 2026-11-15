"""Compare training-only fits on identical held-out cell-days and a common score scale.

python pipeline/compare_refit.py <baseline folder> <candidate folder> <report.json>
No parameters are fitted here. Production coefficients must never be used here.
"""
import json
from pathlib import Path
import sys

import numpy as np
import calibrate as K
import load as L
import refit_features as R
import scores as S
from fetch_era5 import CACHE


def fire_probability(year, e, dates, ok, fitted, fm):
    fwi = np.load(Path(CACHE) / 'fwi' / f'{year}.npy').astype(np.float32)
    fs = K.F.effis_score(fwi[:, ok]) / 100
    months = np.array([d.month for d in dates])
    out = np.empty(fs.shape, np.float64)
    for month in np.unique(months):
        select = months == month
        g = np.nan_to_num(K.ndvi_prev(year, int(month))[ok], nan=.1)
        susceptibility = S.fire_S_month(year, int(month), fm)[ok]
        x = K.fire_design(fs[select], np.broadcast_to(susceptibility, fs[select].shape), np.broadcast_to(g, fs[select].shape),
                          year if len(fitted['beta']) == 7 else None, fitted.get('method', {}).get('time_cap', 2017))
        out[select] = K.predict(x, np.array(fitted['beta'])).reshape(out[select].shape)
    return np.where(e['sd'][:, ok] >= K.SNOW_CM, 0., out)


def dust_probability(year, e, dates, ok, static, fitted):
    months = np.array([d.month for d in dates])
    out = np.empty((len(dates), int(ok.sum())), np.float64)
    for month in np.unique(months):
        select = months == month
        n, t = L.veg(year - (month == 1), 12 if month == 1 else int(month) - 1)
        shape = out[select].shape
        broadcast = lambda a: np.broadcast_to(a, shape)
        x = K.dust_design(e['wmax'][select][:, ok], e['sm'][select][:, ok], broadcast(np.nan_to_num(n[ok], nan=.1)),
                          broadcast(np.nan_to_num(t[ok], nan=1.2)), broadcast(static['lc_barren'][ok]), int(month) if len(fitted['beta']) == 10 else None)
        out[select] = K.predict(x, np.array(fitted['beta'])).reshape(shape)
    return np.where(e['sd'][:, ok] >= K.SNOW_CM, 0., out)


def compare(baseline_dir, candidate_dir):
    static, ok = K.mongolia()
    report = dict(scope='National 0.1-degree grid; no mining-source attribution', comparisons={})
    for hazard, years in [('fire', K.FIRE_TEST), ('dust', K.DUST_TEST)]:
        fitted = {name: json.loads((folder / f'heldout_{hazard}.json').read_text(encoding='utf-8')) for name, folder in [('baseline', baseline_dir), ('candidate', candidate_dir)]}
        params = {name: dict(np.load(folder / 'heldout_fire.npz', allow_pickle=False)) for name, folder in [('baseline', baseline_dir), ('candidate', candidate_dir)]} if hazard == 'fire' else {}
        common_base = fitted['baseline']['base']
        groups = dict(all=range(1, 13)) if hazard == 'fire' else dict(all=range(1, 13), MAM=[3, 4, 5], JJA=[6, 7, 8], SON=[9, 10, 11], DJF=[12, 1, 2])
        records = {name: {group: dict(check=R.ProbabilityCheck(), pos=[], neg=[]) for group in groups} for name in fitted}
        for year in years:
            e, dates = L.era5_year(year)
            months = np.array([d.month for d in dates])[:, None]
            observed = L.obs_year('fire', year, dates)[:, ok] if hazard == 'fire' else L.aai_anomaly(year, dates)[:, ok]
            valid = np.isfinite(observed)
            event = valid & ((observed > 0) if hazard == 'fire' else (observed >= K.AAI_EVENT))
            for name, model in fitted.items():
                p = fire_probability(year, e, dates, ok, model, params[name]) if hazard == 'fire' else dust_probability(year, e, dates, ok, static, model)
                sc = np.rint(K.lift_score(p, common_base)).astype(int)
                for group, select_months in groups.items():
                    keep = valid & np.isin(months, select_months)
                    r = records[name][group]
                    r['check'].add(year, p, event, keep)
                    r['pos'].append(np.bincount(sc[keep & event], minlength=101))
                    r['neg'].append(np.bincount(sc[keep & ~event], minlength=101))
                del p, sc
            print('compare', hazard, year, 'observed cell-days', int(valid.sum()), flush=True)
        summary = {}
        for name, grouped in records.items():
            summary[name] = {}
            for group, r in grouped.items():
                hp, hn = np.array(r['pos']), np.array(r['neg'])
                if hp.sum() and hn.sum():
                    v, u, gaps = K.verify(hp, hn, common_base, 'identical held-out observations')
                else:
                    v, u, gaps = dict(auc=None, auc_ci=None, n=int(hp.sum())), None, []
                v.update(r['check'].result(common_base))
                v.update(u_model=u, reliability_gaps_score=gaps)
                summary[name][group] = v
        key_groups = ['all'] if hazard == 'fire' else ['MAM', 'all']
        checks = {}
        for group in key_groups:
            before, after = summary['baseline'][group], summary['candidate'][group]
            checks[group] = dict(
                auc_not_lower=after['auc'] is not None and before['auc'] is not None and after['auc'] >= before['auc'],
                brier_not_higher=after['brier_exact'] <= before['brier_exact'],
                calibration_closer_to_one=abs(after['predicted_observed_ratio'] - 1) <= abs(before['predicted_observed_ratio'] - 1),
                score_gap_not_higher=after['u_model'] is not None and before['u_model'] is not None and after['u_model'] <= before['u_model'])
        report['comparisons'][hazard] = dict(common_base=common_base, years=list(years), metrics=summary, checks=checks,
            passed=all(all(values.values()) for values in checks.values()))
    report['all_passed'] = all(r['passed'] for r in report['comparisons'].values())
    report['limitations'] = ['All-season baseline dust evaluation extrapolates its spring-trained fit.', '2026 has January-October observations only.', 'This temporal test is not spatially independent station validation.', 'Criteria are screening checks, not proof of statistically significant improvement.']
    return report


if __name__ == '__main__':
    result = compare(Path(sys.argv[1]), Path(sys.argv[2]))
    Path(sys.argv[3]).write_text(json.dumps(result, indent=2, allow_nan=False), encoding='utf-8')
    print('comparison complete; screening checks passed:', result['all_passed'])
