"""Shared settings for the Ukhaa Khudag (UHG) coal-dust study. Runs on GitHub Actions with the repository's Earth Engine key."""
import json
import os
import sys
import time

import ee

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, os.path.join(HERE, "..", "..", "pipeline"))

# Mine reference point: Global Energy Monitor / the site's mine list (43.6668 N, 105.5181 E).
UHG = (105.5181, 43.6668)
# Tavan Tolgoi deposit reference point (Wikipedia), a second large mining complex ~6 km to the SW.
TT = (105.47417, 43.625)
# Study box, about 40 x 40 km.
BOX = [105.27, 43.49, 105.77, 43.85]


def init():
    import common as C  # pipeline/common.py, same service account as the daily site job
    C.init()


def box():
    return ee.Geometry.Rectangle(BOX, "EPSG:4326", False)


def point(p=UHG):
    return ee.Geometry.Point(list(p))


def retry(fn, tries=5):
    wait = 5
    for k in range(tries):
        try:
            return fn()
        except Exception as e:  # Earth Engine transient errors
            msg = str(e)
            if k == tries - 1 or not any(s in msg for s in ("429", "503", "500", "Too Many", "deadline", "Deadline", "timed out", "Internal", "Computation timed")):
                raise
            print("retry after", wait, "s:", msg[:200], flush=True)
            time.sleep(wait)
            wait *= 2


def save_json(name, obj):
    with open(os.path.join(OUT, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)


# ---------------------------------------------------------------- optical sensors

def s2_sr(start, end, max_cloud=30):
    """Sentinel-2 L2A (harmonized) reflectance 0-1, clouds, shadows, snow and cirrus masked with SCL."""
    def prep(img):
        scl = img.select("SCL")
        ok = scl.neq(3).And(scl.neq(8)).And(scl.neq(9)).And(scl.neq(10)).And(scl.neq(11)).And(scl.neq(0)).And(scl.neq(1))
        r = img.select(["B2", "B3", "B4", "B8A", "B11", "B12"], ["blue", "green", "red", "nir", "swir1", "swir2"]).multiply(1e-4)
        return ee.Image(r.updateMask(ok).copyProperties(img, ["system:time_start"]))
    return (ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED").filterBounds(box()).filterDate(start, end)
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", max_cloud)).map(prep))


def landsat_sr(start, end, sensors=("LT05", "LE07", "LC08", "LC09")):
    """Landsat 5/7/8/9 Collection 2 Level 2 reflectance 0-1 with common band names; clouds, shadows, snow masked."""
    def prep(names):
        def f(img):
            qa = img.select("QA_PIXEL")
            ok = qa.bitwiseAnd(0b111110).eq(0)  # dilated cloud, cirrus, cloud, shadow, snow
            r = img.select(names, ["blue", "green", "red", "nir", "swir1", "swir2"]).toFloat().multiply(0.0000275).add(-0.2)
            return ee.Image(r.updateMask(ok).copyProperties(img, ["system:time_start"]))
        return f
    tm = ["SR_B1", "SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B7"]
    oli = ["SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B6", "SR_B7"]
    cols = [("LANDSAT/LT05/C02/T1_L2", tm), ("LANDSAT/LE07/C02/T1_L2", tm), ("LANDSAT/LC08/C02/T1_L2", oli), ("LANDSAT/LC09/C02/T1_L2", oli)]
    out = None
    for cid, names in cols:
        if cid.split("/")[1] not in sensors:
            continue
        c = ee.ImageCollection(cid).filterBounds(box()).filterDate(start, end).filter(ee.Filter.lt("CLOUD_COVER", 40)).map(prep(names))
        out = c if out is None else out.merge(c)
    return out


def indices(r):
    """Coal indices from reflectance bands.
    NDCI = (SWIR1-NIR)/(SWIR1+NIR) and ECDI = (SWIR1-NIR+SWIR2)/(SWIR1+NIR-SWIR2): Xia et al. 2022, PLOS ONE 17:e0266517, Eq. 1-2.
    BCI = (SWIR2-SWIR1)/(NIR*(NIR+SWIR1)): Li et al. 2024, Remote Sensing 16:4648, Eq. 2.
    VIS = mean visible reflectance (surface brightness; coal dust darkens it)."""
    n, s1, s2 = r.select("nir"), r.select("swir1"), r.select("swir2")
    ndci = s1.subtract(n).divide(s1.add(n)).rename("NDCI")
    ecdi = s1.subtract(n).add(s2).divide(s1.add(n).subtract(s2)).rename("ECDI")
    bci = s2.subtract(s1).divide(n.multiply(n.add(s1))).rename("BCI")
    vis = r.select(["blue", "green", "red"]).reduce(ee.Reducer.mean()).rename("VIS")
    ndvi = n.subtract(r.select("red")).divide(n.add(r.select("red"))).rename("NDVI")
    return r.addBands([ndci, ecdi, bci, vis, ndvi])
