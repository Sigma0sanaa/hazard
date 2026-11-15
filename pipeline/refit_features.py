"""Optional refit features. Legacy model files keep their original feature layout.

SPI: zero-adjusted gamma CDF -> normal quantile, fitted separately by calendar
month to training years only. A 25-year record remains shorter than WMO's
preferred 30+ years; this implementation does not claim to remove that limit.
"""
import numpy as np


def gamma_fit(rain):
    """Vectorized loc=0 gamma MLE over axis 0 (years), excluding missing values.

    Degenerate/poorly sampled cells remain missing. The 15-total guard is a
    numerical safeguard, not a WMO climatology criterion. The <0.01 mm zero
    convention and 10-positive guard follow the Copernicus SPI factsheet;
    our estimator is MLE, whereas Copernicus uses L-moments.
    Newton solves log(shape)-digamma(shape)=log(mean(x))-mean(log(x)).
    """
    from scipy.special import digamma, polygamma
    x = np.asarray(rain, dtype=np.float64)
    valid = np.isfinite(x) & (x >= 0)
    x = np.where(valid & (x < .01), 0.0, x)
    positive = valid & (x > 0)
    count, npos = valid.sum(0), positive.sum(0)
    mean = np.where(positive, x, 0).sum(0) / np.maximum(npos, 1)
    mean_log = np.log(np.where(positive, x, 1)).sum(0) / np.maximum(npos, 1)
    a = np.log(np.maximum(mean, 1e-30)) - mean_log
    good = (count >= 15) & (npos >= 10) & (a > 1e-10)
    aa = np.where(good, a, 1.0)
    shape = (3 - aa + np.sqrt((aa - 3) ** 2 + 24 * aa)) / (12 * aa)
    for _ in range(30):
        step = (np.log(shape) - digamma(shape) - aa) / (1 / shape - polygamma(1, shape))
        nxt = np.maximum(shape - np.clip(step, -shape, shape * .9), 1e-6)
        if np.max(np.abs(nxt - shape) / shape) < 1e-10:
            shape = nxt
            break
        shape = nxt
    return dict(spi_shape=np.where(good, shape, np.nan),
                spi_scale=np.where(good, mean / shape, np.nan),
                spi_q=np.where(count > 0, (count - npos) / np.maximum(count, 1), np.nan),
                spi_n=count.astype(np.int16))


def gamma_spi(rain, shape, scale, q):
    from scipy.special import gammainc, ndtri
    x, a, b, zero = np.broadcast_arrays(rain, shape, scale, q)
    valid = np.isfinite(x) & (x >= 0) & np.isfinite(a) & (a > 0) & np.isfinite(b) & (b > 0) & np.isfinite(zero) & (zero >= 0) & (zero < 1)
    x = np.where((x >= 0) & (x < .01), 0.0, x)
    with np.errstate(invalid='ignore', divide='ignore'):
        h = zero + (1 - zero) * gammainc(a, x / b)
        z = ndtri(np.clip(h, 1e-7, 1 - 1e-7))
    return np.where(valid, z, np.nan)


def time_term(year, cap):
    """No extrapolation after the last training year, including held-out tests."""
    return (np.minimum(year, cap) - 2013.0) / 10.0


def wind_threshold(bare):
    """Experimental interpolation of regional ut5% (Kurosaki & Mikami 2007).

    8.9 m/s Gobi; 9.8 m/s northern Mongolian grassland. Interpolation by bare
    fraction is our modelling choice, NOT a measured local station threshold.
    """
    return 9.8 - .9 * np.clip(bare, 0, 1)


def seasonal_terms(month):
    angle = 2 * np.pi * (np.asarray(month) - 1) / 12
    return np.sin(angle), np.cos(angle)


class ProbabilityCheck:
    """Exact probability metrics (not reconstructed from clipped map scores)."""
    def __init__(self):
        self.rows = []

    def add(self, label, probability, event, valid):
        keep = valid & np.isfinite(probability)
        p = np.asarray(probability[keep], dtype=np.float64)
        y = np.asarray(event[keep], dtype=np.float64)
        if not len(p):
            return
        if np.any((p < 0) | (p > 1)):
            raise ValueError('Probability outside [0, 1]')
        self.rows.append(dict(label=str(label), count=len(p), events=int(y.sum()),
                             predicted_events=float(p.sum()), squared_error=float(np.square(p - y).sum())))

    def result(self, training_base):
        n = sum(r['count'] for r in self.rows)
        ev = sum(r['events'] for r in self.rows)
        pred = sum(r['predicted_events'] for r in self.rows)
        sq = sum(r['squared_error'] for r in self.rows)
        ref = ev * (1 - training_base) ** 2 + (n - ev) * training_base ** 2
        return dict(valid_cell_days=n, event_rate=ev / n if n else None,
                    mean_predicted_probability=pred / n if n else None,
                    predicted_observed_ratio=pred / ev if ev else None,
                    brier_exact=sq / n if n else None,
                    brier_skill_training_base=1 - sq / ref if ref else None,
                    probability_checks=self.rows)
