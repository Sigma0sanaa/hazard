# Earth Engine data format · Earth Engine-ийн өгөгдлийн хэлбэр

The page reads files, not live Earth Engine calls. A static site cannot hold an Earth Engine login safely, and the free
Community tier gives 150 EECU-hours a month per project, shared by every request. Computing on a schedule and serving files
keeps the cost independent of the number of visitors.

## Pipeline (`pipeline/`)

| Script | Job |
|---|---|
| `fetch_era5.py`, `fetch_obs.py`, `fetch_gfs.py`, `fetch_static.py` | read inputs from Earth Engine to a local cache (`../gee_cache`, about 7 GB, not in the repository) |
| `calibrate.py` | `prep`, `fire`, `dust`, `flood`, `uinput`: fit the models, verify on unseen years, measure input uncertainty |
| `build.py` | write `data/gee`; with a month argument, only from that month on; `build.py dzud` writes dzud alone |
| `fetch_nso.py` | herds and losses by soum from the National Statistics Office to `nso_soums.csv`; by hand, once a year |
| `dzud.py` | `climate` then `calibrate`: climate per cell, herd pressure, the calibrated chance and its check |
| `dzud_build.py` | the dzud files and their monthly states, called by `build.py` |
| `update.py` | daily job: last two months, from an empty cache, using `model*.npz`, `static_small.npz` and `state/` |
| `soum_names.py` | Cyrillic soum names |
| `build_camps.py` | winter and spring camps as rounded counts, run by hand from the source shapefiles |

Full rebuild: fetch everything, then `calibrate.py prep`, `fire`, `dust`, `flood`, `uinput`, then `build.py`.
`tests/test_fwi_np.py` holds the FWI to the cffdrs reference values.

The daily job writes to the branch `gee-data`, which holds one commit and is replaced on each run, so the repository does not grow. `pages.yml` publishes `data/gee` from that branch; the copy on `main` is only the starting point. A failed download, or data older than 3 days, fails the job, so GitHub reports it and the last good data stay online.

## Files in `data/gee/`

| File | Content |
|---|---|
| `manifest.json` | grid, dates, band order, sources, verification, uncertainty |
| `daily/YYYY-MM.bin.gz` | uint8 `[day][band][ny][nx]`; bands in `manifest.daily_bands`; a day not computed is all 255 |
| `monthly_<h>.bin.gz` | uint8 `[month][ny][nx]`, mean model score, from `first_month`; `h` = `all`, `fire`, `dust`, `flood` |
| `highdays_<h>.bin.gz` | uint8 `[month][ny][nx]`, days with model score ≥ 60, from `first_month` |

| `dzud/YYYY-MM.bin.gz` | uint8 `[day][band][ny][nx]`, November to March only; bands in `manifest.dzud.bands`: score, snow z, cold z. Each day after the first is the change from the day before, modulo 256 |
| `dzud/season_YYYY.bin.gz` | uint8 `[2][ny][nx]`: herd pressure z and summer z of the winter that starts in YYYY |
| `monthly_dzud.bin.gz`, `highdays_dzud.bin.gz` | as above; months outside the season hold no data |

Dzud z-scores are stored as `(z + 3) / 6 · 240` in steps of 10, 255 = no data. The dzud score is `20·(log4(odds / odds of the base rate) + 2)`,
the base rate in `manifest.dzud.base`. Dzud is not part of `all`.

Each year: run `fetch_nso.py` when the December census is out (about February), then `dzud.py climate`, `dzud.py calibrate`,
`build.py dzud`. Until then the latest census in the file is used.

`data/soums.geojson`: 339 soums from geoBoundaries (NSO Mongolia, OCHA ROAP, CC BY 3.0 IGO), simplified; `name`, `aimag` are the
source romanisation, `name_mn`, `aimag_mn` our conversion to Cyrillic.

`data/aimags.geojson`: 22 aimags and the capital, merged from `data/soums.geojson` by `scripts/build_aimags.py`, so that both border layers fit each other. It is run by hand.

`data/camps.bin.gz`: uint16 little-endian records `[x, y, herder_points, cadastre_camps]`, with `x = (lon − 87)·100`, `y = (lat − 41)·100`;
counts in `data/camps_meta.json`. Written once by `pipeline/build_camps.py`, not by the daily job. It holds counts at rounded positions only, and the
source shapefiles must stay out of the repository (see `LIMITATIONS.md`).

Encoding: scores are stored as `value / 0.4`, so 0–100 fits in 0–250. **255 = no data.**
Row 0 is the northern edge. Cell `(r, c)` has its centre at `north − (r + 0.5)·dy`, `west + (c + 0.5)·dx`.
The grid edges coincide with the ERA5-Land pixel edges, so its cells are read without resampling.

Daily files hold the model score raised by what a satellite saw that day. The cubes hold the model score only, otherwise the
start of TROPOMI in 2018 would look like a trend.

## `manifest.json`

`uncertainty[h].u_input` is the standard uncertainty at scores 0, 4, ... 100; `uncertainty[h].u_model` is one number. Leave out what
was not measured: the page then says "not estimated" and shows the error as a lower bound (`≥`). `bridge_from` is the first day
carried by GFS instead of ERA5-Land. `"synthetic": true` puts a red banner on the page and is for test data only.

## Error budget shown for an area

`u_c² = u_input² + u_model² + u_sampling²`, `U = 2·u_c` (JCGM 100).

- `u_input`: the same model run on a second, independent input. Fire and dust: ERA5-Land against NOAA GFS and IMERG, March–October 2025. Flood: IMERG against ERA5-Land rain. Two products differ by √2 times the error of one.
- `u_model`: root mean square gap between the score and the observed event rate, by score class, on unseen years.
- `u_sampling`: computed in the browser from the spatial spread of the selected area, with the sample size reduced for neighbour correlation.
