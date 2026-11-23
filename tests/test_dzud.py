"""Dzud: NSO tables, the winter index, the calibrated chance and the files (pipeline/fetch_nso.py, pipeline/dzud.py).
Run: python tests/test_dzud.py"""
import os
import sys

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


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
