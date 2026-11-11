"""Stage 2: export the inputs of the analysis as arrays (the analysis itself runs offline on these files).

Grid: UTM 48N (EPSG:32648), 30 m, 1334 x 1334 pixels (40 km) centred on Ukhaa Khudag; MAIAC on a 1 km grid, 45 km.
Outputs (research/uhg/out):
  grid.json                        grid and reference points
  landsat_<period>.npz             May-Sep median reflectance x10000 (int16), 6 bands
  s2_<year>.npz                    Sentinel-2 May-Sep median reflectance x10000 (int16), 6 bands, 30 m
  s2_rgb10_core_2024.npz           Sentinel-2 10 m RGB of the central 14 km, Jun-Sep 2024
  static.npz                       ESA WorldCover 2021 class, SRTM elevation
  maiac_<year>.npz                 MAIAC AOD 550 nm per overpass (best quality only), 1 km, with UTC times
  merra2_dust_daily.csv            MERRA-2 DUSMASS (ug/m3) mean of 02-07 UTC: UHG cell and South Gobi box
  s5p_aai_daily.csv                Sentinel-5P absorbing aerosol index, daily mean: 20 km around UHG and the box
"""
import csv
import datetime as dt
import os
import sys

import ee
import numpy as np

import common_uhg as U

N, RES = 1334, 30
MN, MRES = 45, 1000
STAGES = sys.argv[1:] or ["grid", "landsat", "s2", "core", "static", "maiac", "merra", "s5p"]


def grid_info():
    e, n = U.retry(lambda: ee.Geometry.Point(list(U.UHG)).transform("EPSG:32648", 1).coordinates().getInfo())
    tt = U.retry(lambda: ee.Geometry.Point(list(U.TT)).transform("EPSG:32648", 1).coordinates().getInfo())
    x0 = round((e - N * RES / 2) / RES) * RES
    y0 = round((n + N * RES / 2) / RES) * RES
    mx0 = round(e - MN * MRES / 2)
    my0 = round(n + MN * MRES / 2)
    g = dict(crs="EPSG:32648", res=RES, n=N, x0=x0, y0=y0, uhg_utm=[e, n], tt_utm=tt, uhg_lonlat=list(U.UHG), tt_lonlat=list(U.TT),
             maiac=dict(res=MRES, n=MN, x0=mx0, y0=my0))
    U.save_json("grid.json", g)
    return g


def pixels(img, x0, y0, w, h, res):
    req = dict(expression=img, fileFormat="NUMPY_NDARRAY",
               grid=dict(dimensions=dict(width=w, height=h), crsCode="EPSG:32648",
                         affineTransform=dict(scaleX=res, shearX=0, translateX=x0, shearY=0, scaleY=-res, translateY=y0)))
    a = U.retry(lambda: ee.data.computePixels(req))
    return a


def save_bands(name, img, g, bands, scale=10000, w=None, h=None, res=None, x0=None, y0=None):
    w = w or g["n"]; h = h or g["n"]; res = res or g["res"]; x0 = g["x0"] if x0 is None else x0; y0 = g["y0"] if y0 is None else y0
    img = img.select(bands).multiply(scale).round().toInt16().unmask(-32768)
    a = pixels(img, x0, y0, w, h, res)
    arr = np.stack([np.asarray(a[b]) for b in bands]).astype(np.int16)
    np.savez_compressed(os.path.join(U.OUT, name), data=arr, bands=np.array(bands), scale=scale, x0=x0, y0=y0, res=res)
    print("saved", name, arr.shape, flush=True)


REFL = ["blue", "green", "red", "nir", "swir1", "swir2"]


def main():
    U.init()
    g = grid_info()
    print(g, flush=True)

    if "landsat" in STAGES:
        periods = [("2006_2008", "2006", "2008", ("LT05",)), ("2010_2011", "2010", "2011", ("LT05",)),
                   ("2014_2016", "2014", "2016", ("LC08",)), ("2019_2021", "2019", "2021", ("LC08", "LC09")),
                   ("2023_2025", "2023", "2025", ("LC08", "LC09"))]
        counts = {}
        for tag, a, b, sens in periods:
            col = U.landsat_sr(f"{a}-01-01", f"{int(b) + 1}-01-01", sens).filter(ee.Filter.calendarRange(5, 9, "month"))
            counts[tag] = U.retry(lambda: col.size().getInfo())
            save_bands(f"landsat_{tag}.npz", col.median(), g, REFL)
        U.save_json("landsat_counts.json", counts)

    if "s2" in STAGES:
        counts = {}
        for y in range(2019, 2026):
            col = U.s2_sr(f"{y}-05-01", f"{y}-10-01")
            counts[y] = U.retry(lambda: col.size().getInfo())
            save_bands(f"s2_{y}.npz", col.median(), g, REFL)
        U.save_json("s2_counts.json", counts)

    if "core" in STAGES:
        e, n = g["uhg_utm"]
        img = U.s2_sr("2024-06-01", "2024-10-01").median()
        save_bands("s2_rgb10_core_2024.npz", img, g, ["red", "green", "blue"], w=1400, h=1400, res=10,
                   x0=round(e - 7000), y0=round(n + 7000))

    if "static" in STAGES:
        wc = ee.ImageCollection("ESA/WorldCover/v200").first().select("Map").rename("wc")
        dem = ee.Image("USGS/SRTMGL1_003").select("elevation").rename("dem")
        save_bands("static.npz", wc.addBands(dem).toFloat(), g, ["wc", "dem"], scale=1)

    if "maiac" in STAGES:
        m = g["maiac"]
        region = ee.Geometry.Point(list(U.UHG)).buffer(30000)

        def qa(img):
            q = img.select("AOD_QA")
            ok = q.bitwiseAnd(7).eq(1).And(q.rightShift(5).bitwiseAnd(7).eq(0)).And(q.rightShift(8).bitwiseAnd(15).eq(0))
            return img.select("Optical_Depth_055").multiply(0.001).updateMask(ok).toFloat()

        years = list(range(2002, 2009)) + list(range(2017, 2026))
        for y in years:
            stack, times = [], []
            for mth in range(1, 13):
                a = dt.date(y, mth, 1)
                b = dt.date(y + (mth == 12), mth % 12 + 1, 1)
                col = ee.ImageCollection("MODIS/061/MCD19A2_GRANULES").filterBounds(region).filterDate(str(a), str(b)).sort("system:time_start")
                t = U.retry(lambda: col.aggregate_array("system:time_start").getInfo())
                if not t:
                    continue
                img = col.map(qa).toBands()
                names = U.retry(lambda: img.bandNames().getInfo())
                img = img.multiply(1000).round().toInt16().unmask(-32768)
                arr = pixels(img, m["x0"], m["y0"], m["n"], m["n"], m["res"])
                stack.append(np.stack([np.asarray(arr[nm]) for nm in names]).astype(np.int16))
                times += t
            if stack:
                np.savez_compressed(os.path.join(U.OUT, f"maiac_{y}.npz"), aod=np.concatenate(stack), t=np.array(times, np.int64), scale=1000)
                print("maiac", y, len(times), flush=True)

    if "merra" in STAGES:
        sg = ee.Geometry.Rectangle([101, 42.5, 110, 45.5], "EPSG:4326", False)
        pt = U.point()
        rows = []
        for y in range(2002, 2026):
            n_days = (dt.date(y + 1, 1, 1) - dt.date(y, 1, 1)).days
            days = ee.List.sequence(0, n_days - 1)
            start = ee.Date(f"{y}-01-01")

            def one(k):
                d0 = start.advance(k, "day")
                col = ee.ImageCollection("NASA/GSFC/MERRA/aer/2").filterDate(d0, d0.advance(1, "day")).filter(ee.Filter.calendarRange(2, 7, "hour")).select("DUSMASS")
                im = col.mean().multiply(1e9)
                a = im.reduceRegion(ee.Reducer.mean(), pt, 50000).get("DUSMASS")
                b = im.reduceRegion(ee.Reducer.mean(), sg, 50000).get("DUSMASS")
                return ee.Feature(None, dict(date=d0.format("YYYY-MM-dd"), uhg=a, gobi=b, n=col.size()))
            fc = ee.FeatureCollection(days.map(one))
            got = U.retry(lambda: fc.getInfo())
            for f in got["features"]:
                p = f["properties"]
                rows.append([p["date"], p.get("uhg"), p.get("gobi"), p.get("n")])
            print("merra", y, len(got["features"]), flush=True)
        with open(os.path.join(U.OUT, "merra2_dust_daily.csv"), "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date", "dusmass_uhg_ugm3", "dusmass_gobi_ugm3", "n_hours"])
            w.writerows(rows)

    if "s5p" in STAGES:
        near = U.point().buffer(20000)
        rows = []
        for y in range(2018, 2026):
            a = dt.date(y, 7, 10) if y == 2018 else dt.date(y, 1, 1)
            b = dt.date(2025, 10, 31) if y == 2025 else dt.date(y + 1, 1, 1)
            n_days = (b - a).days
            start = ee.Date(str(a))

            def one(k):
                d0 = start.advance(k, "day")
                col = ee.ImageCollection("COPERNICUS/S5P/OFFL/L3_AER_AI").filterDate(d0, d0.advance(1, "day")).select("absorbing_aerosol_index")
                im = col.mean()
                x = im.reduceRegion(ee.Reducer.mean(), near, 5000).get("absorbing_aerosol_index")
                z = im.reduceRegion(ee.Reducer.mean(), U.box(), 5000).get("absorbing_aerosol_index")
                return ee.Feature(None, dict(date=d0.format("YYYY-MM-dd"), near=x, box=z, n=col.size()))
            fc = ee.FeatureCollection(ee.List.sequence(0, n_days - 1).map(one))
            got = U.retry(lambda: fc.getInfo())
            for f in got["features"]:
                p = f["properties"]
                rows.append([p["date"], p.get("near"), p.get("box"), p.get("n")])
            print("s5p", y, len(got["features"]), flush=True)
        with open(os.path.join(U.OUT, "s5p_aai_daily.csv"), "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date", "aai_20km", "aai_box", "n_images"])
            w.writerows(rows)


if __name__ == "__main__":
    main()
