"""Figures for the UHG coal-dust study (Mongolian labels). python figures.py <inputs> <results> <figure folder>"""
import json
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import patches
from matplotlib.lines import Line2D
from pyproj import Transformer

IN, RES, FIG = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(FIG, exist_ok=True)
plt.rcParams.update({"font.family": "Liberation Serif", "font.size": 9, "axes.titlesize": 10, "axes.labelsize": 9,
                     "savefig.dpi": 220, "savefig.bbox": "tight"})
G = json.load(open(os.path.join(IN, "grid.json")))
R = json.load(open(os.path.join(RES, "results.json")))
M = np.load(os.path.join(RES, "maps.npz"))
N, RES_M = G["n"], G["res"]
X0, Y0 = G["x0"], G["y0"]
UX, UY = G["uhg_utm"]
EXT = [(X0 - UX) / 1000, (X0 + N * RES_M - UX) / 1000, (Y0 - N * RES_M - UY) / 1000, (Y0 - UY) / 1000]  # km from UHG
ll2utm = Transformer.from_crs("EPSG:4326", "EPSG:32648", always_xy=True)
CX, CY = R["footprint"]["centre_utm"]
D, U = R["downwind_sectors"], R["upwind_sectors"]
SECT = 16


def rgb_from(path, lo=0.02, hi=0.40, gamma=1.3):
    z = np.load(path)
    d = z["data"].astype(float)
    d[d == -32768] = np.nan
    d /= float(z["scale"])
    b = [str(x) for x in z["bands"]]
    im = np.stack([d[b.index("red")], d[b.index("green")], d[b.index("blue")]], -1)
    return np.nan_to_num(np.clip((im - lo) / (hi - lo), 0, 1) ** (1 / gamma))


def km(x, y):
    return (np.asarray(x) - UX) / 1000, (np.asarray(y) - UY) / 1000


def wedge(ax, secs, r0, r1, color, label):
    w = 360 / SECT
    a0 = min(secs) * w - w / 2
    a1 = max(secs) * w + w / 2
    if max(secs) - min(secs) > SECT // 2:   # wraps through north
        a0, a1 = max(secs) * w - w / 2, min(secs) * w + w / 2 + 360
    cx, cy = km(CX, CY)
    # matplotlib angles are counter-clockwise from east; bearings are clockwise from north
    p = patches.Wedge((cx, cy), r1, 90 - a1, 90 - a0, width=r1 - r0, facecolor=color, alpha=0.22, edgecolor=color, lw=1.0, label=label)
    ax.add_patch(p)


def osm_lines(ax):
    p = os.path.join(IN, "osm_box.json")
    if not os.path.exists(p):
        return
    for e in json.load(open(p))["elements"]:
        t = e.get("tags", {})
        if e["type"] != "way" or "geometry" not in e:
            continue
        lon = [g["lon"] for g in e["geometry"]]; lat = [g["lat"] for g in e["geometry"]]
        x, y = ll2utm.transform(lon, lat)
        x, y = km(x, y)
        if t.get("railway") == "rail":
            ax.plot(x, y, color="black", lw=0.9, ls=(0, (4, 2)), zorder=4)
        elif t.get("highway") in ("primary", "trunk"):
            ax.plot(x, y, color="#ffd23f", lw=1.0, zorder=4)


def fig1():
    fig = plt.figure(figsize=(6.6, 4.4))
    ax = fig.add_axes([0.30, 0.0, 0.70, 1.0])
    ax.imshow(rgb_from(os.path.join(IN, "s2_2024.npz")), extent=EXT)
    fp = M["fp"]; dist = M["dist"]
    xs = np.linspace(EXT[0], EXT[1], N); ys = np.linspace(EXT[3], EXT[2], N)
    ax.contour(xs, ys, fp.astype(float), levels=[0.5], colors="red", linewidths=1.0)
    cs = ax.contour(xs, ys, dist, levels=[500, 5000, 10000], colors="white", linewidths=0.7, linestyles="--")
    ax.clabel(cs, fmt={500: "0.5 км", 5000: "5 км", 10000: "10 км"}, fontsize=7, colors="white")
    sec = M["sec"]; valid = M["valid"]
    near = valid & (dist >= 500) & (dist < 5000)
    ov = np.zeros((N, N, 4))
    ov[near & np.isin(sec, D)] = (1.0, 0.50, 0.05, 0.38)
    ov[near & np.isin(sec, U)] = (0.12, 0.47, 0.71, 0.38)
    ax.imshow(ov, extent=EXT, zorder=3)
    osm_lines(ax)
    tx, ty = km(*G["tt_utm"])
    town = ll2utm.transform(105.5734, 43.7296)
    for (x, y), name in (((0, 0), "Ухаа худаг"), ((tx, ty), "Таван толгой"), (km(*town), "Цогтцэций")):
        ax.plot(x, y, marker="^" if name != "Цогтцэций" else "s", color="yellow", mec="black", ms=6, zorder=6)
        ax.annotate(name, (x, y), xytext=(4, 4), textcoords="offset points", color="white", fontsize=8, weight="bold",
                    path_effects=[matplotlib.patheffects.withStroke(linewidth=2, foreground="black")])
    ax.set_xlim(EXT[0], EXT[1]); ax.set_ylim(EXT[2], EXT[3])
    ax.set_xlabel("Зүүн тийш, км (UTM 48N, Ухаа худагаас)"); ax.set_ylabel("Хойд тийш, км")
    ax.plot([8, 13], [-17.5, -17.5], color="white", lw=3); ax.text(10.5, -16.8, "5 км", color="white", ha="center", fontsize=8)
    ax.annotate("Х", xy=(17, -12), xytext=(17, -15.5), color="white", ha="center", fontsize=10, weight="bold",
                arrowprops=dict(arrowstyle="-|>", color="white", lw=1.5))
    h = [Line2D([], [], color="red", lw=1, label="Уурхайн ул мөр (2023–2025)"), Line2D([], [], color="white", ls="--", lw=0.7, label="Ул мөрөөс зай"),
         patches.Patch(color="#ff7f0e", alpha=0.4, label="Салхины доод тал (D)"), patches.Patch(color="#1f77b4", alpha=0.4, label="Салхины дээд тал (U)"),
         Line2D([], [], color="black", ls=(0, (4, 2)), label="Төмөр зам (OSM)"), Line2D([], [], color="#ffd23f", label="Авто зам (OSM)")]
    ax.legend(handles=h, loc="upper left", fontsize=6.5, framealpha=0.85)
    # inset: Mongolia
    ins = fig.add_axes([0.0, 0.52, 0.27, 0.40])
    mg = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "data", "mongolia.geojson")))
    for f in mg["features"]:
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            a = np.array(poly[0]); ins.fill(a[:, 0], a[:, 1], color="#f2e6c9", ec="black", lw=0.5)
    ins.plot(*G["uhg_lonlat"], marker="*", color="red", ms=9)
    ins.set_aspect(1.4); ins.set_xticks([]); ins.set_yticks([]); ins.set_title("Монгол Улс", fontsize=8)
    t = fig.add_axes([0.0, 0.05, 0.27, 0.40]); t.axis("off")
    t.text(0, 1, "Ухаа худаг: 43.667° Х, 105.518° З\nЦогтцэций сум, Өмнөговь аймаг\n\nСуурь зураг: Sentinel-2 L2A,\n2024 оны 5–9 сарын медиан\n\nУурхайн ул мөр = нүүрсэн гадаргуу\n(BCI ≥ 0.8) + 2006–2008 оноос хойш\nгадаргын гэрэлтэлт ≥0.05-аар\nөөрчлөгдсөн талбай",
           va="top", fontsize=7.5)
    fig.savefig(os.path.join(FIG, "fig1_study_area.png"))
    plt.close(fig)


def fig2():
    fig, ax = plt.subplots(figsize=(6.6, 3.5)); ax.axis("off"); ax.set_xlim(0, 100); ax.set_ylim(0, 60)
    def box(x, y, w, h, txt, fc):
        ax.add_patch(patches.FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.4,rounding_size=1.5", fc=fc, ec="#333333", lw=0.8))
        ax.text(x + w / 2, y + h / 2, txt, ha="center", va="center", fontsize=6.4)
    def arr(x0, y0, x1, y1):
        ax.annotate("", xy=(x1, y1), xytext=(x0, y0), arrowprops=dict(arrowstyle="-|>", color="#333333", lw=0.8))
    c1, c2, c3 = "#fde9d9", "#e2efda", "#ddebf7"
    box(1, 46, 22, 11, "Sentinel-2 L2A (2019–2025)\nLandsat 5/8/9 L2\n(2006–2008 … 2023–2025)", c1)
    box(1, 31, 22, 11, "MODIS MAIAC AOD 1 км\n(2002–2008, 2017–2025)", c1)
    box(1, 16, 22, 11, "ERA5-Land цагийн салхи\nMERRA-2 тоос, S5P AAI", c1)
    box(1, 1, 22, 11, "ESA WorldCover, OSM,\nMMC олборлолтын тайлан", c1)
    box(29, 46, 32, 11, "1–2. Нүүрсэн гадаргуу, ул мөр:\nBCI ≥ 0.8; ECDI → FCD (2 бүрэлдэхүүн)\nNDCI, VIS — харьцуулалт", c2)
    box(29, 31, 32, 11, "3. Байгалийн тоосны үе:\nMERRA-2 DUSMASS ≥ 90-р перц.,\nтоос хөдлөх цаг: салхи ≥ 6 м/с, хуурай", c2)
    box(29, 16, 32, 11, "5. Шилжилт (HYSPLIT-ийн оронд):\nERA5 салхиар 1–6 цагийн кинематик\nзамнал; доод/дээд талын сектор", c2)
    box(29, 1, 32, 11, "6. Нарийвчлал: давхаргажсан 80 цэг,\nалдааны матриц, OA, precision,\nrecall, κ", c2)
    box(66, 24, 33, 20, "4. Уурхайн нэмэлт нөлөө (DiD):\nΔY = (Y_D,H − Y_U,H) − (Y_D,L − Y_U,L)\nY: FCD, VIS (гадаргуу), AOD (агаар)\nH/L: олборлолтын өмнө/дараа;\n2022 I хагас (бага) / 2023 I хагас (их)\nСекторыг эргүүлэх тест, bootstrap", c3)
    box(66, 3, 33, 14, "Үр дүн: hazard сайтын\nresearch/uhg-dust салбар\n(GitHub Actions + Earth Engine)", "#fff2cc")
    for y in (51.5, 36.5, 21.5, 6.5):
        arr(23.5, y, 28.3, y)
    for y in (51.5, 36.5, 21.5):
        arr(61.6, y, 65.4, 34)
    arr(82.5, 23.5, 82.5, 17.5)
    fig.savefig(os.path.join(FIG, "fig2_method.png"))
    plt.close(fig)


def fig3():
    w = R["wind"]
    fig = plt.figure(figsize=(6.6, 3.0))
    ax = fig.add_subplot(1, 2, 1, projection="polar")
    th = np.radians(np.arange(SECT) * 360 / SECT)
    ax.set_theta_zero_location("N"); ax.set_theta_direction(-1)
    f = np.array(w["toward_freq_dust"]) * 100
    cols = ["#ff7f0e" if k in D else ("#1f77b4" if k in U else "#9e9e9e") for k in range(SECT)]
    ax.bar(th, f, width=np.radians(360 / SECT) * 0.9, color=cols, edgecolor="black", lw=0.4)
    ax.set_xticks(np.radians([0, 90, 180, 270])); ax.set_xticklabels(["Х", "З", "Ө", "Б"])
    ax.set_yticks([5, 10, 15]); ax.set_yticklabels(["5%", "10%", "15%"], fontsize=7)
    ax.set_title("а) Тоос хөдлөх цагт агаар чиглэх\nзүг (2009–2025, n = %d цаг)" % w["dust_hours"], fontsize=9)
    ax2 = fig.add_subplot(1, 2, 2)
    z = np.load(os.path.join(RES, "traj.npz"))
    dx, dy = z["dx1"] / 1000, z["dy1"] / 1000
    h = ax2.hist2d(dx, dy, bins=60, range=[[-45, 45], [-45, 45]], cmap="YlOrBr", cmin=1)
    ax2.plot(0, 0, marker="^", color="red", mec="black", ms=7)
    for r_ in (10, 20, 30, 40):
        ax2.add_patch(patches.Circle((0, 0), r_, fill=False, ls=":", lw=0.6, color="gray"))
    ax2.set_aspect("equal"); ax2.set_xlabel("км (зүүн)"); ax2.set_ylabel("км (хойд)")
    ax2.set_title("б) 1 цагийн дараах агаарын хэсгийн\nбайрлал (кинематик замнал)", fontsize=9)
    fig.colorbar(h[3], ax=ax2, fraction=0.046, pad=0.03, label="цагийн тоо")
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, "fig3_wind_transport.png"))
    plt.close(fig)


def fig4():
    fig, axs = plt.subplots(1, 3, figsize=(6.8, 2.6))
    cut = slice(N // 2 - 450, N // 2 + 450)
    ext = [EXT[0] + (N // 2 - 450) * RES_M / 1000, EXT[0] + (N // 2 + 450) * RES_M / 1000,
           EXT[3] - (N // 2 + 450) * RES_M / 1000, EXT[3] - (N // 2 - 450) * RES_M / 1000]
    fp = M["fp"][cut, cut]
    xs = np.linspace(ext[0], ext[1], fp.shape[1]); ys = np.linspace(ext[3], ext[2], fp.shape[0])
    for ax, arr_, t, cmap, vmin, vmax in ((axs[0], M["fcd_pre"], "а) FCD, 2006–2008 (өмнө)", "magma_r", 0, 0.5),
                                          (axs[1], M["fcd_post"], "б) FCD, 2023–2025 (дараа)", "magma_r", 0, 0.5),
                                          (axs[2], M["fcd_post"] - M["fcd_pre"], "в) ΔFCD (дараа − өмнө)", "RdBu_r", -0.3, 0.3)):
        a = arr_[cut, cut].astype(float)
        a = np.where(fp, np.nan, a)
        im = ax.imshow(a, extent=ext, cmap=cmap, vmin=vmin, vmax=vmax)
        ax.contour(xs, ys, fp.astype(float), levels=[0.5], colors="black", linewidths=0.6)
        ax.set_title(t, fontsize=8.5); ax.tick_params(labelsize=7)
        fig.colorbar(im, ax=ax, fraction=0.046, pad=0.02).ax.tick_params(labelsize=7)
    axs[0].set_ylabel("км"); axs[1].set_xlabel("км (Ухаа худагаас)")
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, "fig4_fcd_maps.png"))
    plt.close(fig)


def fig5():
    pr = R["profiles"]; rings = np.array(pr["rings"]) / 1000
    mid = (rings[:-1] + rings[1:]) / 2
    fig, axs = plt.subplots(1, 3, figsize=(6.9, 2.6), gridspec_kw=dict(width_ratios=[1.25, 1, 1]))
    ax = axs[0]
    for tag, ls in (("2006_2008", "--"), ("2023_2025", "-")):
        a = np.array(pr["data"][f"landsat_{tag}_FCD"], float)
        yrs = tag.replace("_", "–")
        ax.plot(mid, np.nanmean(a[:, D], 1), ls, color="#ff7f0e", marker="o", ms=3, label=f"D {yrs}")
        ax.plot(mid, np.nanmean(a[:, U], 1), ls, color="#1f77b4", marker="s", ms=3, label=f"U {yrs}")
    ax.set_xscale("log"); ax.set_xlabel("Ул мөрөөс зай, км"); ax.set_ylabel("Дундаж FCD")
    ax.set_title("а) FCD-ийн зайн профиль", fontsize=8.5); ax.legend(fontsize=6)
    rows = R["surface_did"]["by_ring_landsat"]
    for ax, key, t, sc, lab in ((axs[1], "FCD", "б) ΔFCD (DiD) цагираг бүрээр", 1, "ΔFCD"),
                                (axs[2], "VIS", "в) ΔVIS (DiD) цагираг бүрээр", 100, "ΔVIS × 100")):
        rr = rows[key]
        x = np.arange(len(rr))
        v = [r_["delta"] * sc for r_ in rr]
        ax.bar(x, v, color=["#ff7f0e" if r_["p_rotation"] <= 0.25 else "#bdbdbd" for r_ in rr], edgecolor="black", lw=0.3)
        for xi, r_ in zip(x, rr):
            ax.text(xi, r_["delta"] * sc, f"{r_['rank']}/16", ha="center", va="bottom" if r_["delta"] >= 0 else "top", fontsize=5.8)
        ax.axhline(0, color="black", lw=0.6)
        ax.set_xticks(x); ax.set_xticklabels([f"{r_['r0'] / 1000:g}–{r_['r1'] / 1000:g}" for r_ in rr], rotation=45, fontsize=6.5)
        ax.set_xlabel("Зай, км"); ax.set_ylabel(lab); ax.set_title(t, fontsize=8.5)
        lo, hi = ax.get_ylim(); ax.set_ylim(lo - 0.15 * (hi - lo), hi + 0.15 * (hi - lo))
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, "fig5_profiles_rotation.png"))
    plt.close(fig)


def fig6():
    a = R["aod"]; nd = R["natural_dust"]
    fig, axs = plt.subplots(1, 2, figsize=(6.8, 2.8))
    ax = axs[0]
    keys = [("pre 2002-2008", "2002–2008"), ("post 2017-2025", "2017–2025"), ("2022 Jan-Jun (low output)", "2022 I хагас"),
            ("2023 Jan-Jun (high output)", "2023 I хагас"), ("pre, high natural dust", "Өмнө, их тоос"), ("post, high natural dust", "Дараа, их тоос")]
    m = [a[k]["mean"] for k, _ in keys]; lo = [a[k]["mean"] - a[k]["ci"][0] for k, _ in keys]; hi = [a[k]["ci"][1] - a[k]["mean"] for k, _ in keys]
    ax.bar(range(len(keys)), m, yerr=[lo, hi], color=["#9ecae1", "#3182bd", "#fdae6b", "#e6550d", "#c7e9c0", "#31a354"], edgecolor="black", lw=0.4, capsize=2)
    ax.axhline(0, color="black", lw=0.6)
    ax.set_xticks(range(len(keys))); ax.set_xticklabels([b for _, b in keys], rotation=35, ha="right", fontsize=7)
    ax.set_ylabel("AOD: D − U (1–10 км)"); ax.set_title("а) MAIAC AOD-ийн доод/дээд талын ялгаа\n(95% bootstrap интервал)", fontsize=8.5)
    ax = axs[1]
    mons = np.arange(1, 13)
    ax.bar(mons, nd["monthly_mean"], color="#c9a66b", edgecolor="black", lw=0.4, label="MERRA-2 тоос, мкг/м³")
    ax.set_xticks(mons); ax.set_xlabel("Сар"); ax.set_ylabel("Дундаж DUSMASS, мкг/м³")
    ax2 = ax.twinx()
    dh = np.array(R["wind"]["dust_hours_by_month"]) / 17
    ax2.plot(mons, dh, color="#3b3b3b", marker="o", ms=3, label="Тоос хөдлөх цаг/жил")
    ax2.set_ylabel("Тоос хөдлөх цаг / жил")
    ax.set_title("б) Байгалийн тоосны улирлын явц\n(2002–2025; салхи 2009–2025)", fontsize=8.5)
    h1, l1 = ax.get_legend_handles_labels(); h2, l2 = ax2.get_legend_handles_labels()
    ax.legend(h1 + h2, l1 + l2, fontsize=6.3, loc="upper center", bbox_to_anchor=(0.5, -0.2), ncol=2, frameon=False)
    fig.tight_layout()
    fig.savefig(os.path.join(FIG, "fig6_aod_natural.png"))
    plt.close(fig)


if __name__ == "__main__":
    import matplotlib.patheffects  # noqa: F401
    for f in (fig1, fig2, fig3, fig4, fig5, fig6):
        f()
        print("ok", f.__name__)
