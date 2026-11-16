"""Audit actual coverage before calibration; write counts, never infer missing events.

python pipeline/audit_cache.py <report.json>
"""
import datetime as dt
import json
from pathlib import Path
import sys

import numpy as np
from fetch_era5 import CACHE, chunks


def audit(end='2026-10-31'):
    root = Path(CACHE)
    with np.load(root / 'static.npz', allow_pickle=False) as z:
        mask = z['mask'] >= .5
    result = dict(end=end, cells=int(mask.sum()), datasets={})
    for kind, start, bands in [('era5', '2001-01-01', 10), ('fire', '2001-01-01', None), ('rain', '2001-01-01', None), ('aai', '2018-07-01', None)]:
        row = dict(files=0, valid_values=0, total_values=0, missing_days=[], minimum=None, maximum=None)
        for tag, first, last in chunks(dt.date.fromisoformat(start), dt.date.fromisoformat(end)):
            days = (last - first).days + 1
            a = np.load(root / kind / (tag + '.npy'), mmap_mode='r', allow_pickle=False)
            shape = ((bands, days) if bands else (days,)) + mask.shape
            if a.shape != shape or a.dtype != np.float16:
                raise ValueError(f'{kind}/{tag}: invalid shape or dtype {a.shape}, {a.dtype}')
            v = a[..., mask]
            valid = np.isfinite(v)
            row['files'] += 1
            row['valid_values'] += int(valid.sum())
            row['total_values'] += int(valid.size)
            by_day = valid.any(axis=(0, 2)) if bands else valid.any(axis=1)
            row['missing_days'] += [str(first + dt.timedelta(days=int(i))) for i in np.flatnonzero(~by_day)]
            if valid.any():
                lo, hi = float(v[valid].min()), float(v[valid].max())
                row['minimum'] = lo if row['minimum'] is None else min(row['minimum'], lo)
                row['maximum'] = hi if row['maximum'] is None else max(row['maximum'], hi)
        row['valid_fraction'] = row['valid_values'] / row['total_values']
        result['datasets'][kind] = row
        print(kind, row['files'], 'valid fraction', row['valid_fraction'], 'missing days', len(row['missing_days']), flush=True)
        if kind == 'era5' and row['valid_fraction'] < .999:
            raise ValueError('ERA5 has missing values inside Mongolia: investigate before calibration')
    return result


if __name__ == '__main__':
    report = audit()
    Path(sys.argv[1]).write_text(json.dumps(report, indent=2), encoding='utf-8')
