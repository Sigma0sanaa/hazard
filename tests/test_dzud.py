"""Dzud: NSO tables, the winter index, the calibrated chance and the files (pipeline/fetch_nso.py, pipeline/dzud.py).
Run: python tests/test_dzud.py"""
import os
import sys
import tempfile

import numpy as np

os.environ["HAZARD_CACHE"] = tempfile.mkdtemp()  # a small cache of made-up weather, never the real one
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


def test_chance():
    import dzud as D
    b = 0.124
    assert abs(D.to_score(b, b) - 40) < 1e-9
    assert all(abs(D.to_p(D.to_score(p, b), b) - p) < 1e-9 for p in (0.02, 0.1, 0.3))
    assert abs(D.to_score(0.0001 * 4, 0.0001) - 60) < 0.02  # a rare event: the same score as fire and dust get
    assert D.to_score(0.9999, b) == 100 and D.to_score(1e-9, b) == 0
    assert abs(D.auc(np.array([1, 1, 0, 0]), np.array([4., 2., 3., 1.])) - 0.75) < 1e-9
    assert abs(D.auc(np.array([1, 0, 1, 0]), np.ones(4)) - 0.5) < 1e-9  # ties count half
    rng = np.random.default_rng(2)
    x = rng.normal(size=20000)
    y = (rng.random(20000) < 1 / (1 + np.exp(2 - 1.5 * x))).astype(float)
    a, sl = D.fit_line(x, y)
    assert abs(a + 2) < 0.1 and abs(sl - 1.5) < 0.1
    a, sl = D.fit_line(-x, y)  # a date where a worse index went with fewer losses: no skill, so the average chance for all
    assert sl == 0 and abs(1 / (1 + np.exp(-a)) - y.mean()) < 1e-9


def test_files():
    """The daily job, which starts from an empty cache and a stored state, must write the same bytes as the full run."""
    import calendar
    import gzip
    import shutil
    from datetime import date, timedelta
    import common as C
    import dzud as D
    import dzud_build as B
    from fetch_era5 import BANDS, CACHE
    size, C.NY, C.NX = (C.NY, C.NX), 2, 3
    try:
        rng = np.random.default_rng(3)
        era, veg = os.path.join(CACHE, "era5"), os.path.join(CACHE, "veg")
        os.makedirs(era), os.makedirs(veg)
        for y, m in [(2001, 11), (2001, 12)] + [(2002, k) for k in (1, 2, 3, 11, 12)] + [(2003, 1), (2003, 2)]:
            last = calendar.monthrange(y, m)[1] if (y, m) != (2003, 2) else 20
            for half, a, b in (("a", 1, 16), ("b", 17, last)):
                x = np.zeros((len(BANDS), b - a + 1, 2, 3), np.float16)
                x[BANDS.index("t")], x[BANDS.index("sd")] = rng.normal(-15, 6, x.shape[1:]), rng.random(x.shape[1:]) * 15
                np.save(os.path.join(era, f"{y}{m:02d}{half}.npy"), x)
        for y in (2001, 2002):
            for m in (7, 8):
                np.save(os.path.join(veg, f"{y}{m:02d}.npy"), np.full((2, 2, 3), 0.3, np.float16))
        n = len(D.NODES)
        g = dict(t_mu=np.full((n, 2, 3), -15.0), t_sd=np.full((n, 2, 3), 2.0), s_mu=np.full((n, 2, 3), 1.8), s_sd=np.full((n, 2, 3), 0.3),
                 n_mu=np.full((2, 3), 0.28), n_sd=np.full((2, 3), 0.05), press=np.zeros((2, 2, 3)), p_years=np.array([2000, 2001]))
        m = dict(a=[-2.0] * n, b=list(np.linspace(0.7, 2.0, n)), base=0.124)
        cells = np.ones((2, 3), bool)
        cells[0, 0] = False
        full, st = tempfile.mkdtemp(), tempfile.mkdtemp()
        bridge = [(date(2003, 2, 21), np.full((2, 3), -10.0)), (date(2003, 2, 22), np.full((2, 3), -11.0))]
        open(os.path.join(st, "fwi_2003-02.npz"), "w").close()
        assert B.build(full, st, None, date(2003, 2, 22), g, m, cells, bridge) == []
        assert os.path.exists(os.path.join(st, "fwi_2003-02.npz"))  # another hazard's state is left alone
        have = sorted(os.listdir(os.path.join(full, "dzud")))
        assert have == ["2001-11.bin.gz", "2001-12.bin.gz", "2002-01.bin.gz", "2002-02.bin.gz", "2002-03.bin.gz", "2002-11.bin.gz", "2002-12.bin.gz",
                        "2003-01.bin.gz", "2003-02.bin.gz", "season_2001.bin.gz", "season_2002.bin.gz"]
        feb = B.undelta(np.frombuffer(gzip.open(os.path.join(full, "dzud", "2003-02.bin.gz")).read(), np.uint8).reshape(28, 3, 2, 3))
        x = rng.integers(0, 256, (5, 2), np.uint8)
        assert (B.undelta(B.delta(x)) == x).all()
        assert B.encode_z(np.array([-3.0, 0.0, 0.26, 3.0, np.nan])).tolist() == [0, 120, 130, 240, 255]
        assert (feb[:, :, 0, 0] == 255).all() and (feb[:22, :, 1, 1] != 255).all() and (feb[22:] == 255).all()  # outside, computed, not yet
        cube = np.frombuffer(gzip.open(os.path.join(full, "monthly_dzud.bin.gz")).read(), np.uint8).reshape(-1, 2, 3)
        assert len(cube) == 26 and (cube[:10] == 255).all() and cube[10, 1, 1] != 255 and (cube[15] == 255).all()  # April 2002 is out of season
        # the daily job: the cache holds only 17 December on, no summer NDVI; the state carries the rest
        job = tempfile.mkdtemp()
        shutil.copytree(full, job, dirs_exist_ok=True)
        for f in os.listdir(era):
            if f < "200212b.npy":
                os.remove(os.path.join(era, f))
        shutil.rmtree(veg)
        os.remove(os.path.join(job, "dzud", "2003-01.bin.gz"))
        assert B.build(job, st, (2003, 1), date(2003, 2, 22), g, m, cells, bridge) == []
        for f in have + ["../monthly_dzud.bin.gz", "../highdays_dzud.bin.gz"]:
            assert open(os.path.join(full, "dzud", f), "rb").read() == open(os.path.join(job, "dzud", f), "rb").read(), f
        # 1-2 November 2002, before ERA5-Land has any day of the winter: GFS temperature on the snow of 31 October
        early, es = tempfile.mkdtemp(), tempfile.mkdtemp()
        for m_ in (7, 8):
            os.makedirs(veg, exist_ok=True)
            np.save(os.path.join(veg, f"2002{m_:02d}.npy"), np.full((2, 2, 3), 0.3, np.float16))
        shutil.rmtree(era), os.makedirs(era)
        two = [(date(2002, 10, 31), np.full((2, 3), -4.0)), (date(2002, 11, 1), np.full((2, 3), -5.0)), (date(2002, 11, 2), np.full((2, 3), -6.0))]
        assert B.build(early, es, (2002, 10), date(2002, 11, 2), g, m, cells, two, np.full((2, 3), 2.0)) == []
        nov = B.undelta(np.frombuffer(gzip.open(os.path.join(early, "dzud", "2002-11.bin.gz")).read(), np.uint8).reshape(30, 3, 2, 3))
        assert (nov[:2, :, 1, 1] != 255).all() and (nov[2:] == 255).all()
        # without the state there is no score, and the job says so
        assert B.build(tempfile.mkdtemp(), tempfile.mkdtemp(), (2003, 1), date(2003, 2, 22), g, m, cells, bridge) != []
    finally:
        C.NY, C.NX = size


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
