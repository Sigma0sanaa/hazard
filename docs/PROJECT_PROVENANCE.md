# Төслийн гарал үүслийн бүртгэл · Project provenance

Энэ файл төсөл хэзээ, юунаас, хэрхэн бий болсныг тэмдэглэнэ. Git-ийн коммит нь огноо, өөрчлөлтийг харуулах боловч **хуулийн өмчлөлийг дангаараа нотлохгүй**. Коммитын нэр, огноог тухайн компьютерээс бичдэг бөгөөд GitHub бүртгэл эзэмших нь зохиогч болохыг тогтоохгүй.

This file records when and how the project came to exist. Git commits show dates and changes, but **they do not by themselves prove legal ownership**. Commit names and dates are set on the committer's computer, and holding a GitHub account does not establish authorship.

## Identification

| | |
|---|---|
| Name | Mongolia Hazard Watch · Монгол орны гамшгийн эрсдэлийн хяналт |
| Repository | https://github.com/Sigma0sanaa/hazard |
| Website | https://sigma0sanaa.github.io/hazard/ |
| Description | Flood, wildfire and dust storm risk for Mongolia on a 0.1° grid from 2001 to today, with stated error, area statistics, a soum view and a mine dust tool, from open satellite and model data |
| Stage | Work in progress. Not an official warning service |
| Maintainer | Sigma0sanaa (GitHub account) |

## Baseline record

| | |
|---|---|
| Commit | `9e444f063c43864a168a3890df063affaba0bc63` |
| Commit time | 2026-11-07T16:43:58Z (2026-11-08 00:43:58 +08:00) |
| Reached GitHub | `pushed_at` 2026-11-07T16:44:02Z, from the GitHub API |
| Tag | `copyright-baseline-2026-11-08`, annotated, created 2026-11-07T16:51:14Z |
| Commits on `main` | 24 |

A tag can be moved or deleted by anyone with write access, unless a rule in the repository settings stops it. No such rule has been set.

Offline backups were made from this commit and kept outside the repository:

| File | SHA-256 |
|---|---|
| All refs, `git bundle` (`hazard_all_refs_9e444f063c43.bundle`) | `284390a084d5c518ecd3ddf595fbf99294d5eab3a11a5582b0f16b92a64be3dc` |
| Full tree (`hazard_full_tree_9e444f063c43.zip`) | `8a4bf267769a92a625d45639d9746755a5668dd0a92fc656588d0019c5bae0ee` |
| Own source only, no `data/` or `vendor/` (`hazard_own_source_9e444f063c43.zip`) | `8774c40e2f44083c96eb918b063c697b190c130bb27ca701352a84ada3680ad3` |

To check a copy: `sha256sum <file>`, and `git bundle verify <file>` for the bundle.

## Verified facts

Read from Git and the public GitHub API on 2026-11-08.

* The repository was created on GitHub at 2026-11-03T13:45:53Z, under the user account Sigma0sanaa. It is public and is not a fork.
* The first commit is `e465c51`, dated 2026-11-03T13:47:34Z, authored as Sigma0sanaa.
* Of 24 commits, 19 carry the author name Sigma0sanaa, 4 Claude, and 1 hazard-bot (an automated data update).
* 23 commits name Claude as co-author in a `Co-Authored-By` line: Claude Opus 5.5 in 17 and Claude Sonnet 5.5 in 6. AI assistance was therefore substantial and is stated here openly.
* GitHub detects no license. There are 0 stars and 1 fork.
* The history has not been rewritten during this review. Branch `gee-data` is a daily automated branch that always holds one commit by design.

## Assumptions and open points

These are not verified and need the rights holder:

* **Who the legal author is.** The real person or persons behind the account, and their share of the creative work.
* **The human contribution.** Requirements, choice of methods, corrections and review came from the maintainer through the working sessions. The repository alone does not prove how far this makes each part a human creation. See [INTELLECTUAL_PROPERTY_POLICY.md](INTELLECTUAL_PROPERTY_POLICY.md).
* **Employment, study or funding.** Whether the work was done under a job, a commission, a course or outside funding, which could change who holds the rights (Law on Copyright, 19, 20, 22.3).
* **Other contributors.** Git shows no other human author, but this does not exclude people who gave ideas, text or data outside Git.
* **Why `package.json` says MIT.** See [LICENSE_REVIEW.md](LICENSE_REVIEW.md).

## Website architecture

* Static site on GitHub Pages, plain ES modules, no build step, Leaflet for the map.
* `pipeline/` runs on GitHub Actions: Google Earth Engine inputs are turned into daily grids, which are stored in branch `gee-data` and copied into the site when it is deployed.
* The browser computes area statistics, error budgets, the dust plume and all download formats from those grids, so there is no server of its own.
* `.github/workflows/pages.yml` runs the tests before each deployment, and `gee.yml` runs the daily update.

## Main original contributions

The parts below exist in the repository (verified). Who is their legal author remains open, as stated above. Methods themselves are not protected by copyright, only their expression in code and text.

| Part | Where |
|---|---|
| Interface: hazard menu, day picker, rectangle selection, results panel, methods window | `index.html`, `css/app.css`, `js/app.js`, `js/statspanel.js`, `js/methods.js`, `js/ui_text.js` |
| Risk grids and their calibration | `pipeline/` |
| Uncertainty budget and trend statistics | `js/stats.js`, `js/area.js` |
| Mine dust plume with stability, rain and mixing layer | `js/plume.js`, `js/tools.js`, `js/materials.js` |
| Map drawing, camps and wind marks | `js/riskmap.js`, `js/mapmarks.js`, `js/export.js` |
| Hand-written file formats and download packages | `js/formats.js`, `js/downloads.js` |
| Tests | `tests/` |
| Written method, limits and source review | `docs/` |

## Milestones

| Date | Commit | Event |
|---|---|---|
| 2026-11-03 | `e465c51` | First version: flood, wildfire and dust indices for aimag centres |
| 2026-11-03 | `85c2ba7` | GIBS layers read from GetCapabilities |
| 2026-11-05 | `9015d57` | Polygon risk tool and mine dust plume |
| 2026-11-06 | `d64afc6` | Risk zones from Earth Engine, day picker, statistics, soum view |
| 2026-11-06 | `b50e447` | Daily data moved to its own branch |
| 2026-11-07 | `2900c82` | Camps, dust types, map downloads |
| 2026-11-07 | `d211809` | Opens on the satellite image, downloads by data type |
| 2026-11-07 | `9bb1913` | A colour family per hazard, borders, explanation in every download |
| 2026-11-07 | `35427e0` | JRC water layer, improved dust model |
| 2026-11-07 | `cee7784` | Clear classes, cartographic borders |
| 2026-11-08 | `9e444f0` | Downloads ready for GIS software, results inside every file. Baseline |

## Third-party dependencies and sources

These are not the project's work. Details and terms are in [DATA_SOURCES.md](DATA_SOURCES.md), `README.md` and `js/methods.js`.

| Item | Use | Terms noted |
|---|---|---|
| Leaflet 1.9.4 | map library, bundled in `vendor/leaflet/` | BSD-2-Clause |
| NASA GIBS, MODIS, VIIRS, FIRMS | imagery, fire detections | NASA acknowledgement |
| ECMWF ERA5-Land | weather history | Copernicus terms |
| NOAA GFS | recent weather | public US government data |
| NASA GPM IMERG V07 | rain | NASA acknowledgement |
| Sentinel-5P TROPOMI aerosol index | dust | Copernicus terms |
| MODIS MCD12Q1, MCD43A4, MCD64A1 | land cover, reflectance, burned area | NASA acknowledgement |
| MERIT Hydro, Global Flood Database, JRC Global Surface Water | terrain, flood reference, water | each dataset's licence |
| Open-Meteo, CAMS, GloFAS | wind for the mine tool, air quality, river flow | CC BY 4.0, free tier non-commercial; credit CAMS and Copernicus |
| geoBoundaries (NSO Mongolia, OCHA ROAP) | soum and aimag lines | CC BY 3.0 IGO |
| Natural Earth via world-atlas | national outline | public domain, ISC |
| Cadastre and herder register behind `data/camps.bin.gz` | anonymised camp points | **licence not confirmed**; excluded from any ownership claim |
| Published equations and standards (Briggs, US EPA, AP-42, CALPUFF, JCGM 100 and others) | methods, cited in `js/methods.js` | cited as sources, not claimed |
