# Mine dust attribution by rain-reset cycles

Design, 2026-11-13. Written in English to match the rest of `docs/`.

## Intent

The vegetation box (`js/minedust_veg.js`, `js/minedust_vegbox.js`) already measures where dust
settles around a coal mine: the NDVI of each of 16 wind sectors against the median of the same
ring, on a clean/dusty image pair chosen by the emission episodes between them.

Its evidence is geometric. A sector carries a deficit, and the wind blew that way. That is
consistent with the mine, but it does not exclude a feature of the ground that is itself
directional: a haul road, the grazing ring around the mine camp, a soil or landform band. Such a
feature lies in the same sector every summer, and the ring median does not remove it, because the
ring median removes what is alike at one distance in every direction, not what is fixed in one
direction.

This design adds the test that separates the two.

## Why now

The result is to become a permanent layer of the Dust tab, and the number it produces is the
entry for a student science conference (submission 2026-11-15).

## The claim to support

The dust on the vegetation around the mine comes from the mine, not from a fixed feature of the
ground that happens to lie downwind.

## The test

A confounder fixed in space cannot follow a rotating wind.

Every washing rain clears the leaves. Between that rain and the next clear image, emission hours
occur with their own wind directions. Across such cycles the wind direction varies; a road does
not. So two models compete:

* **Wind-following.** The sector of the deficit tracks the episode rose of that cycle.
* **Fixed.** The deficit sits in the same sector in every cycle, whatever the wind did.

Fit both across cycles and compare. This is a repeated natural experiment, not one correlation.

## Spike result (Baganuur, 2026-11-13)

Run in the browser with the module's own `emissionWeight`, `episodes` and `pairPlans`. ERA5 from
the Open-Meteo archive, Sentinel-2 passes from the Planetary Computer STAC.

| Summer | S2 passes | Episodes | Usable cycles | Rose-peak sectors |
| --- | --- | --- | --- | --- |
| 2021 | 45 | 13 | 1 | 4 |
| 2022 | 58 | 13 | 3 | 6, 4, 6 |
| 2023 | 81 | 25 | 3 | 9, 7, 7 |
| 2024 | 50 | 13 | 4 | 7, 4, 4, 6 |
| 2025 | 56 | 15 | 4 | 4, 8, 4, 10 |

15 usable cycles over five summers, across 6 of the 16 sectors, spanning about 135 degrees from
east to south-west. Enough spread to separate the two models.

Three qualifications on that count. The clear share used was `eo:cloud_cover`, a scene-level
number, where the box uses a per-ring clear mask; the real count will be lower, because cloud
gathers in the sector that matters. Three plans returned no episode because the spike's picking
window was strict (`ep.i0 > rain && ep.i1 <= pass`) and missed episodes that straddle the edge.
Only Baganuur was measured; the other six `VEG_MINES` are unknown.

One observation worth keeping. `VEG_REPORTS.baganuur.downwind` is `[6, 7, 8]`, but 5 of the 15
cycles peak in sector 4. Either ERA5 and the report's wind disagree, or the report describes the
year as a whole while the emission hours fall differently. The panel should show this rather than
smooth it away.

## Goals

* A per-cycle record for a mine and a summer: the rain, the episodes and their rose, the image
  pair, the sector deficits, the clear cover.
* A cross-cycle statistic that separates wind-following from fixed, with a number that can fail.
* A permanent panel in the vegetation box, and the cycles as a downloadable table.
* One exhibit that makes the result readable at a glance.

## Non-goals

* An absolute dust load. The measure stays in NDVI units, as the box's note already says.
* Mineral or elemental identification of the dust.
* Mines beyond Baganuur in the first version, though the code runs for every `VEG_MINES` entry.

## Anti-goals

* A statistic that cannot come out against the mine. If the fixed model wins, the panel says so
  in plain words.
* Hidden cycles. Every candidate is listed, the excluded ones with their reason.
* A p-value printed from three points. Below the floor the panel reports "too few cycles".

## Constraints

* Browser only. Static site, no server, no build step.
* Free data only: ERA5 through the Open-Meteo archive, Sentinel-2 L2A through the Planetary
  Computer. Both are already used by the box.
* One mine-year costs about a minute today. Years are computed on demand, one at a time, and
  cached for the session; all five summers are never fetched at once.
* Reuse the exported functions of `js/minedust_veg.js`. No second implementation of the rings,
  the rose, the episodes or the deficits.

## Approaches considered

**Placebo mines.** Run the same pipeline at 20-30 random steppe points with no mine. If it
reports dusty sectors there at the same rate, the method proves nothing. Cheap, and it falsifies
the method, but it does not identify the mine as the source. Kept as a later addition.

**Spectral fingerprint.** Coal dust lowers reflectance across all wavelengths; soil dust raises
it in the visible. Adding a brightness change beside the NDVI change would identify the material,
independent of wind geometry. The strongest evidence of the three, but it may sit below detection
at these loads, and it risks producing nothing before the deadline. A separate study.

**Rain-reset cycles — chosen.** It uses what is already built, needs no new data source, and
excludes fixed confounders directly, which is the objection the current method cannot answer.
The spike shows both enough cycles and enough wind spread for it to work.

## Design

### Per cycle

A cycle is one plan from `pairPlans`: a washing rain, the emission episodes after it, a dusty
pass, and a clean composite before it. For each cycle compute:

* `rose_c` — the weight-combined rose of the episodes between the rain and the dusty pass.
  Loosen the picking to episodes that *overlap* the interval, not only those contained in it;
  the strict window is what left three spike plans without a rose.
* `def_c[s]` — the inner-ring (3-6 km) deficit per sector, from `deficits` on the `ndviChange`
  of that cycle's two composites.
* `cover_c` — the share of the 3-6 km ring seen clear in both composites. Under the floor the
  cycle is listed but left out of the statistic.

### Cross-cycle statistic

Pooled over cycles `c` and sectors `s`:

* Wind model: `def_c[s] ~ a + b * rose_c[s]`
* Fixed model: `def_c[s] ~ a + f[s]`, one free level per sector, shared across cycles.

Four details settle how the fit behaves, decided here rather than left open.

* Cycles differ in emission weight, so a strong cycle would otherwise dominate. Standardise
  `def_c[s]` within its own cycle (z-score across its 16 sectors) before pooling. The question is
  where the deficit sits, not how deep it is.
* The fixed model carries 16 free levels against the wind model's 2, so variance explained
  favours it mechanically. Compare by AIC, or by leaving one cycle out and predicting it.
* A cycle in which no sector passes the deficit threshold stays in the regression, because a true
  zero is evidence, but it has no deficit peak and so is left out of the circular measure.
* Shuffling the roses among cycles is the right null precisely because it leaves any fixed
  structure in the deficits untouched. Only the pairing between wind and deficit is broken.

Report three things:

1. `b`, its sign, and a permutation test: shuffle the roses among the cycles, refit, 1000 draws,
   and take the share of draws reaching the observed `b`. This is the headline, because it
   assumes no distribution and answers the question directly: could the alignment be chance?
2. The variance each model explains, so a fixed feature that also happens to be downwind is
   visible rather than hidden.
3. The mean angular distance between each cycle's rose peak and its deficit peak, against the
   same quantity under shuffling.

### The exhibit

One scatter, one point per cycle: the episode-rose bearing on the x axis, the deficit-peak
bearing on the y axis, with the 1:1 diagonal drawn. Wind-following puts the points on the
diagonal; a fixed confounder puts them in a horizontal band. This is the figure for the
conference.

### Panel

A third collapsible box under «Уурхайн тоосжилт ба ургамал», named «Циклийн шалгуур».

* Mine from the existing picker; a year or a range of years.
* A table of cycles: rain date, clean date, dusty date, episodes, emission weight, cover, rose
  peak, deficit peak, used or excluded with the reason.
* The scatter.
* One line with `b`, the permutation `p`, the number of cycles and the sector spread, and a
  plain Mongolian sentence saying which model the data favour.
* A cycles CSV in the existing download.

## Left to the builder

* The cover floor; start at 0.5 of the 3-6 km ring and say the value in the methods window.
* Whether to pool mines. The first version keeps them separate.
* Caching: one computed year per mine, in memory, for the session.
* `pairPlans` returns one plan per dusty pass, and the Planetary Computer lists several items for
  one date where tiles overlap, so plans must be deduplicated by dusty date before counting. The
  spike's raw plan counts (4, 7, 10, 9, 9) fall to the 1, 3, 3, 4, 4 of the table for this reason.
* The wind date and hour in the result window should default to the dusty pass's date instead of
  today, which the user asked for separately. Fold it in while this box is open.

## Risks

* **Too few cycles.** A small or cloudy mine may not reach the floor of 6 usable cycles. The
  panel must say "too few cycles" and print no statistic.
* **Wind spread too narrow.** If every cycle of a year peaks in one sector, the two models cannot
  be told apart. Report the spread beside the statistic and say so when it is too narrow.
* **Cover.** The spike's scene-level cloud figure flatters the count; per-ring cover will cut it,
  possibly below the floor for some years.
* **Deadline.** Two days. The minimum that stands on its own is the cycle table, the permutation
  test and the scatter. The panel's polish and the CSV can follow.

## Sources

* `js/minedust_veg.js`, `docs/METHODS.md` "Mine dust and vegetation", "Emission episodes and the
  report check", "Clean and dusty image pair".
* Open-Meteo ERA5 archive API; Microsoft Planetary Computer STAC, `sentinel-2-l2a`.
* Ranjan & Parida 2024, J. Environ. Manage. 367; Ma et al. 2020, Remote Sensing 12;
  Themistocleous & Prodromou 2023, ISPRS Archives XLVIII-1/W2 (already cited by the box).
