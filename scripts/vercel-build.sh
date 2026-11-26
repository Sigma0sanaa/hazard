#!/usr/bin/env bash
# Vercel build: assembles the same _site folder that .github/workflows/pages.yml publishes to GitHub Pages.
#
# Vercel's build has no .git folder, so the Earth Engine data on the branch gee-data are downloaded as a tarball
# from GitHub (the repository is public). If that fails, the starting copy in data/gee on main is served instead,
# and the build says so: the site still works, only with older data.
set -euo pipefail

OWNER="${VERCEL_GIT_REPO_OWNER:-Sigma0sanaa}"
REPO="${VERCEL_GIT_REPO_SLUG:-hazard}"
SITE=_site
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

rm -rf "$SITE"
mkdir "$SITE"
cp -r index.html css js vendor data docs "$SITE"/
cp sitemap.xml google692f6804d2dc0f57.html "$SITE"/

# Latest Earth Engine data from the branch gee-data
url="https://codeload.github.com/$OWNER/$REPO/tar.gz/refs/heads/gee-data"
if curl -fsSL --retry 3 --max-time 300 "$url" -o "$TMP/gee.tgz" \
   && tar -xzf "$TMP/gee.tgz" -C "$TMP" \
   && gee="$(find "$TMP" -mindepth 3 -maxdepth 3 -type d -path '*/data/gee' | head -1)" \
   && [ -n "$gee" ] && [ -f "$gee/manifest.json" ]; then
  rm -rf "$SITE/data/gee"
  cp -r "$gee" "$SITE/data/gee"
  # dzud came after the other hazards: where gee-data does not hold it yet, the copy on main is kept (as in pages.yml)
  for f in dzud monthly_dzud.bin.gz highdays_dzud.bin.gz; do
    if [ ! -e "$SITE/data/gee/$f" ] && [ -e "data/gee/$f" ]; then cp -r "data/gee/$f" "$SITE/data/gee/$f"; fi
  done
  echo "Earth Engine data taken from gee-data: $(grep -m1 '"last_date"' "$SITE/data/gee/manifest.json")"
else
  echo "WARNING: could not download gee-data; serving the starting copy of data/gee from main"
fi

# Live point data (Open-Meteo, optional NASA FIRMS with FIRMS_MAP_KEY). Optional: the page computes live without it.
if node scripts/build-latest.mjs; then
  for f in latest.json fires.json; do
    if [ -f "data/$f" ]; then cp "data/$f" "$SITE/data/$f"; fi
  done
else
  echo "WARNING: live data build failed; the site will compute live in the browser"
fi

echo "Site assembled: $(du -sh "$SITE" | cut -f1), $(find "$SITE" -type f | wc -l) files"
