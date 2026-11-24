# 3D view of flood, wildfire and dust in a chosen area · Design (2026-11-24)

## Intent

The owner asked (2026-11-24) that the area and day a user picks can be seen in 3D on the terrain:

* **Flood:** how the water of the chosen days spreads and moves over the ground of the area.
* **Dust storm:** how dust is lifted and blown over the surface.
* **Wildfire:** how a fire would spread, played hour by hour like a recording.
* **Dzud:** not in 3D for now.

Audience: emergency staff, the public (warnings) and research. The result must download as a **video**.
On the ignition point the owner chose "the highest possible resolution".

## Goals, non-goals, anti-goals

* Goals: one 3D window shared by the three hazards; 30 m terrain (Copernicus DEM GLO-30, the finest open DEM over
  Mongolia); a time line that plays, pauses and scrubs; a video download (MP4 where the browser records it, WebM
  otherwise); the inputs, the model and its limits written next to the picture.
* Non-goals: dzud; river overbank floods from upstream discharge; crown fire; dust concentration in µg/m³.
* Anti-goals: anything that looks like an observation or an official forecast when it is a model run. Every frame of
  the view and of the video carries "model, not observation". No invented input: a missing input stops the run and
  says which one.

## Approaches considered

1. **Leaflet stays, a separate three.js window for the 3D run (chosen).** No build step (three.js vendored like
   Leaflet), full control of the simulation grid and of the frames that go into the video.
2. MapLibre GL with terrain tiles: good 3D map, but it needs terrain-RGB tiles that no free source serves for the
   Copernicus DEM without a key, and its frames are harder to drive for a simulation.
3. CesiumJS: heavy (≈ 3 MB+), Ion token for terrain. Rejected.

## How each hazard is run (all in the user's browser)

* **Inputs.** DEM: Copernicus GLO-30 via the Planetary Computer data API (already used by the flood check). Land
  cover: ESA WorldCover 2021 (10 m, taken onto the grid). Weather: Open-Meteo hourly (forecast for recent days, ERA5
  archive before) at a 4 × 4 lattice of points, spread over the grid by inverse-distance weighting. Picture:
  clearest Sentinel-2 colour pass (existing `js/aoi/backdrop.js`).
* **Flood.** Rain plus snowmelt (snow-depth loss when above 0 °C, snow density 0.3 assumed) becomes runoff by the
  SCS curve number (USDA TR-55, hydrologic soil group C assumed). Runoff is routed over the DEM by the local
  inertial shallow-water scheme (Bates et al. 2010; de Almeida et al. 2012, LISFLOOD-FP), Manning's n by land cover.
  It runs on the graphics card (WebGL2 float textures) at 30 m up to 1024 × 1024 cells; a CPU copy of the same
  scheme runs where the card cannot (coarser grid) and is what the tests check. 72 hours from the chosen day.
* **Wildfire.** Rothermel (1972) surface spread with Albini's (1976) corrections, Anderson (1982) fuel models by land
  cover, 1-h dead fuel moisture from hourly temperature and humidity (NFDRS equilibrium moisture, Simard 1968), wind
  and slope combined as vectors, elliptical spread (Anderson 1983), arrival times by a shortest-time search on a
  16-neighbour grid at 30 m (as the minimum travel time method, Finney 2002). Snow on the ground or rain stops it.
  Ignition, finest first: Sentinel-2 active fire on the day (20 m, Hu et al. 2021 rules) → VIIRS 375 m (FIRMS, from
  the site's daily build, last 3 days) → MODIS 1 km (MOD14A1/MYD14A1, Planetary Computer) → a point the user clicks.
  The user can always click instead. 24 hours from the chosen hour.
* **Dust.** Emission where Sentinel-2 marks bare or sparse ground (existing dust check), the ground is dry and free
  of snow and the wind is above the published Mongolian threshold (Kurosaki & Mikami 2007); strength by White's (1979)
  saltation flux shape. Particles are released in proportion and blown by the hourly wind field. A relative picture,
  no mass. 72 hours.

## UI

A "3D" button in each of the three detailed-check boxes opens a full-screen window for the drawn area and the day on
the date bar: terrain with the satellite picture, the hazard on it, a time line (play, pause, speed, hour), a legend,
the inputs and limits, and "Record video". The video is recorded from a canvas that holds the 3D picture, the title,
the time, the legend and the "model" label.

## Left to the builder

Colours, the vertical exaggeration default (×2), the frame rate (30 fps), the detail of the mesh.
