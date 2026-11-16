"""Run: python -m unittest discover -s tests -p test_refit.py"""
import sys
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np
from scipy.stats import gamma, norm

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pipeline'))
import calibrate as K
import refit_features as R
import scores as S


class RefitTests(unittest.TestCase):
    def test_gamma_matches_independent_scipy_mle(self):
        rng = np.random.default_rng(19)
        x = rng.gamma(1.3, 15, (100, 3))
        x[:12, 0] = 0
        x[:7, 1] = np.nan
        fit = R.gamma_fit(x)
        for k in range(3):
            positive = x[np.isfinite(x[:, k]) & (x[:, k] >= .01), k]
            a, _, scale = gamma.fit(positive, floc=0)
            np.testing.assert_allclose(fit['spi_shape'][k], a, rtol=1e-7)
            np.testing.assert_allclose(fit['spi_scale'][k], scale, rtol=1e-7)
        self.assertAlmostEqual(fit['spi_q'][0], .13)
        self.assertEqual(fit['spi_n'][1], 93)

    def test_mixture_cdf_and_missing_values(self):
        x = np.array([0, 1, 10, 100, np.nan, -1])
        actual = R.gamma_spi(x, 2, 8, .2)
        np.testing.assert_allclose(actual[:4], norm.ppf(.2 + .8 * gamma.cdf(x[:4], 2, scale=8)))
        self.assertTrue(np.isnan(actual[4:]).all())
        self.assertTrue(np.all(np.diff(actual[:4]) > 0))
        for data in [np.zeros((25, 2)), np.ones((25, 2)), np.full((25, 2), np.nan), np.ones((5, 2))]:
            fit = R.gamma_fit(data)
            self.assertTrue(np.isnan(fit['spi_shape']).all())

    def test_time_is_capped_at_training_boundary(self):
        np.testing.assert_allclose(R.time_term(np.array([2001, 2017, 2025]), 2017), [-1.2, .4, .4])
        x = np.ones((2, 3))
        self.assertEqual(K.fire_design(x, x, x).shape, (6, 6))
        self.assertEqual(K.fire_design(x, x, x, 2020, 2017).shape, (6, 7))
        np.testing.assert_allclose(K.fire_design(x, x, x, 2020, 2017)[:, -1], .4)

    def test_dust_features_and_season_boundary(self):
        np.testing.assert_allclose(R.wind_threshold(np.array([0, 1, 2, -1])), [9.8, 8.9, 8.9, 9.8])
        np.testing.assert_allclose(R.seasonal_terms(1), R.seasonal_terms(13), atol=1e-14)
        x = np.ones((3, 4))
        self.assertEqual(K.dust_design(x, x, x, x, x).shape, (12, 8))
        self.assertEqual(K.dust_design(x, x, x, x, x, 7).shape, (12, 10))

    def test_scorers_match_calibration_and_reject_missing_context(self):
        x = np.array([[2., 8.], [12., 15.]])
        for beta in [np.array([-4, .2, 1, -.2, .1, .2]), np.array([-4, .2, 1, -.2, .1, .2, -.5])]:
            fs = S.F.effis_score(x) / 100
            design = K.fire_design(fs.ravel(), np.full(4, .5), np.full(4, .2), 2026 if len(beta) == 7 else None)
            expected = K.lift_score(K.predict(design, beta), .01).reshape(x.shape)
            actual = S.fire_model_score(x, np.zeros_like(x), .2, .5, beta, .01, year=2026)
            np.testing.assert_allclose(actual, expected)
        with self.assertRaises(ValueError):
            S.fire_model_score(x, x, .2, .5, np.zeros(7), .01)
        with self.assertRaises(ValueError):
            S.dust_model_score(x, x, x, .2, 1, .5, np.zeros(10), .01)

    def test_spi_uses_completed_previous_month(self):
        fm = dict(S=np.ones((2, 2)), w=1., spi_shape=np.full((12, 2, 2), 2.), spi_scale=np.full((12, 2, 2), 4.), spi_q=np.zeros((12, 2, 2)))
        with patch.object(S, 'month_rain', return_value=np.ones((2, 2))) as read:
            S.fire_S_month(2025, 1, fm)
            read.assert_called_once_with(2024, 12)

    def test_probability_check_counts_only_observed(self):
        c = R.ProbabilityCheck()
        c.add('test', np.array([.9, .1, .8]), np.array([1, 0, 1]), np.array([True, True, False]))
        result = c.result(.5)
        self.assertEqual(result['valid_cell_days'], 2)
        self.assertAlmostEqual(result['brier_exact'], .01)
        self.assertAlmostEqual(result['predicted_observed_ratio'], 1.)
        self.assertAlmostEqual(result['brier_skill_training_base'], .96)


if __name__ == '__main__':
    unittest.main()
