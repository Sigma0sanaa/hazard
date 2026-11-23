"""Dzud: NSO tables, the winter index, the calibrated chance and the files (pipeline/fetch_nso.py, pipeline/dzud.py).
Run: python tests/test_dzud.py"""
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "pipeline"))


def test_nso():
    import fetch_nso as N
    assert N.parse("-") == 0.0 and N.parse("..") is None and N.parse("") is None and N.parse("12.5") == 12.5
    assert abs(N.sheep_units(dict(camel=1, horse=1, cattle=1, sheep=1, goat=1)) - 19.9) < 1e-9
    assert N.sheep_units(dict(camel=1, horse=1)) is None  # a kind that is missing is not a kind of zero
    # a soum with no camels is published as "..": the table's own total tells a true zero from a missing figure
    assert N.fill(dict(horse=0.0, cattle=0.0, sheep=0.1, goat=0.2), 0.3)["camel"] == 0.0
    assert abs(N.fill(dict(horse=1.0, cattle=0.0, sheep=2.0, goat=2.0), 6.5)["camel"] - 1.5) < 1e-9
    assert N.sheep_units(N.fill(dict(sheep=1.0, goat=1.0), 9.0)) is None  # three kinds missing and the total not met
    assert N.sheep_units(N.fill(dict(horse=0.0, cattle=0.0, sheep=0.1, goat=0.2), None)) is None
    assert N.norm("Дарви сум") == N.norm("дарви") and N.norm("Говь-Угтаал") == N.norm("Говь Угтаал")
    assert N.match(*N.local_example()) == {0: "18101", 1: "18201"}  # one name in two aimags


def test_season():
    import dzud as D
    from datetime import date
    assert D.winter_of(date(2026, 11, 1)) == 2026 and D.winter_of(date(2027, 3, 31)) == 2026
    assert D.winter_of(date(2027, 4, 1)) is None and D.winter_of(date(2026, 10, 31)) is None
    assert D.season_day(date(2026, 11, 1)) == 0 and D.season_day(date(2027, 3, 31)) == D.LAST_DAY == D.season_day(date(2024, 3, 31))
    assert D.season_day(date(2024, 2, 29)) == D.season_day(date(2024, 3, 1)) == D.season_day(date(2023, 3, 1)) == 120
    t = np.array([float(n) for n in D.NODES])
    assert all(abs(D.at_node(t, k) - k) < 1e-9 for k in range(D.LAST_DAY + 1))


def test_index():
    import dzud as D
    assert abs(D.index(1, 1, 1, 1) - 1) < 1e-9 and abs(D.index(1, 0, 0, 0) - 0.41 / 1.29) < 1e-9
    assert np.isnan(D.index(np.nan, 0, 0, 0))  # a missing indicator is no score, never a zero
    assert D.zscore(np.array(9.0), 0.0, 1e-9, 1.0) == 3.0 and abs(D.zscore(np.array(0.05), 0.0, 0.0, 0.1) - 0.5) < 1e-9
    rng = np.random.default_rng(1)
    t, sd = rng.normal(-20, 5, (151, 2, 3)), rng.random((151, 2, 3)) * 20
    whole = D.Acc((2, 3))
    for k in range(151):
        whole.add(t[k], sd[k])
    part = D.Acc((2, 3))
    for k in range(61):  # to 31 December
        part.add(t[k], sd[k])
    path = os.path.join(tempfile.mkdtemp(), "acc.npz")
    part.save(path)
    resumed = D.Acc.load(path)
    for k in range(61, 151):
        resumed.add(t[k], sd[k])
    for a, b in zip(whole.mean(), resumed.mean()):
        assert np.allclose(a, b, atol=1e-5)  # the turn of the year and a stored state change nothing
    gap = whole.copy()
    gap.add(np.full((2, 3), np.nan), sd[0])
    assert np.isnan(gap.mean()[0]).all() and np.isfinite(whole.mean()[0]).all()


def test_pressure():
    import dzud as D
    g = lambda a: (dict(aimag=a[0], name=a[1]), a[2], np.array([a[3]]))
    soums = [g(("A", "wide", 1000.0, 0)), g(("A", "town", 50.0, 1)), g(("B", "big", 1000.0, 2)), g(("B", "none", 1000.0, 3))]
    table = {(0, 2020): (10.0, None), (1, 2020): (50.0, None), (2, 2020): (100.0, None)}
    z = D.pressure_by_soum(2020, soums, np.ones(4), table)
    assert np.isnan(z[3]) and z[2] == np.nanmax(z)  # no herd: no figure
    assert z[1] < z[2]  # the town has 1000 sheep units per km2 of its own, and takes its aimag's 57


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
