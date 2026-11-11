"""Stage 1: look at the study area. Images, index ranges, hourly ERA5 wind (Open-Meteo) and OpenStreetMap features."""
import io
import json
import os

import ee
import requests

import common_uhg as U


def thumb(img, region, name, dims=1600, **vis):
    url = U.retry(lambda: img.getThumbURL(dict(region=region, dimensions=dims, format="png", **vis)))
    r = requests.get(url, timeout=300)
    r.raise_for_status()
    open(os.path.join(U.OUT, name), "wb").write(r.content)
    print("saved", name, len(r.content), flush=True)


def main():
    U.init()
    box = U.box()
    core = U.point().buffer(7000).bounds()
    stats = {}

    s2 = U.indices(U.s2_sr("2024-06-01", "2024-10-01").median())
    l5 = U.indices(U.landsat_sr("2006-06-01", "2008-10-01").filterDate("2006-06-01", "2008-10-01").median())
    l8 = U.indices(U.landsat_sr("2024-06-01", "2024-10-01").median())
    rgb = dict(bands=["red", "green", "blue"], min=0.02, max=0.40, gamma=1.3)
    thumb(s2, box, "s2_rgb_2024_box.png", **rgb)
    thumb(s2, core, "s2_rgb_2024_core.png", dims=1400, **rgb)
    thumb(l5, box, "landsat_rgb_2006_2008_box.png", **rgb)
    thumb(l8, box, "landsat_rgb_2024_box.png", **rgb)

    pct = [2, 5, 10, 25, 50, 75, 90, 95, 98]
    for tag, img, scale in (("s2_2024", s2, 20), ("l5_2006_2008", l5, 30), ("l8_2024", l8, 30)):
        d = U.retry(lambda: img.select(["NDCI", "ECDI", "BCI", "VIS", "NDVI"]).reduceRegion(
            ee.Reducer.percentile(pct), box, scale, maxPixels=1e10, bestEffort=True).getInfo())
        stats[tag] = d
        print(tag, json.dumps(d)[:400], flush=True)
    U.save_json("stage1_index_percentiles.json", stats)

    pal = ["000000", "3b3b3b", "8c6d46", "d9c39a", "ffffff"]
    for b in ("NDCI", "ECDI", "BCI", "VIS"):
        lo, hi = stats["s2_2024"][f"{b}_p2"], stats["s2_2024"][f"{b}_p98"]
        thumb(s2.select(b), box, f"s2_{b}_2024_box.png", min=lo, max=hi, palette=pal)
        thumb(s2.select(b), core, f"s2_{b}_2024_core.png", dims=1400, min=lo, max=hi, palette=pal)

    # Hourly ERA5 (Open-Meteo archive), the same source the site uses for wind.
    lon, lat = U.UHG
    rows = []
    for y0 in range(2000, 2026, 4):
        y1 = min(y0 + 3, 2025)
        end = f"{y1}-12-31" if y1 < 2025 else "2025-10-31"
        url = ("https://archive-api.open-meteo.com/v1/archive?latitude=%.4f&longitude=%.4f&start_date=%d-01-01&end_date=%s"
               "&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation,snow_depth,soil_moisture_0_to_7cm,relative_humidity_2m"
               "&wind_speed_unit=ms&timezone=GMT&models=era5" % (lat, lon, y0, end))
        r = requests.get(url, timeout=600)
        r.raise_for_status()
        h = r.json()["hourly"]
        keys = [k for k in h if k != "time"]
        for i, t in enumerate(h["time"]):
            rows.append([t] + [h[k][i] for k in keys])
        print("open-meteo", y0, y1, len(h["time"]), flush=True)
    import gzip
    with gzip.open(os.path.join(U.OUT, "era5_hourly_uhg.csv.gz"), "wt", encoding="utf-8") as f:
        f.write(",".join(["time"] + keys) + "\n")
        for row in rows:
            f.write(",".join("" if v is None else str(v) for v in row) + "\n")

    # OpenStreetMap roads, railways, quarries and places in the box.
    w, s, e, n = U.BOX
    q = f"""[out:json][timeout:180];
(
 way["highway"~"motorway|trunk|primary|secondary|tertiary|unclassified|track|service"]({s},{w},{n},{e});
 way["railway"]({s},{w},{n},{e});
 way["landuse"~"quarry|industrial"]({s},{w},{n},{e});
 relation["landuse"~"quarry|industrial"]({s},{w},{n},{e});
 node["place"]({s},{w},{n},{e});
 way["man_made"~"spoil_heap|mineshaft"]({s},{w},{n},{e});
);
out geom;"""
    for host in ("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"):
        try:
            r = requests.post(host, data={"data": q}, timeout=300)
            r.raise_for_status()
            open(os.path.join(U.OUT, "osm_box.json"), "w", encoding="utf-8").write(r.text)
            print("osm", len(r.json()["elements"]), flush=True)
            break
        except Exception as ex:
            print("overpass failed", host, ex, flush=True)


if __name__ == "__main__":
    main()
