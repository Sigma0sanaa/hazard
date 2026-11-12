# Ухаа худаг: уурхайн тоосны нэмэлт нөлөөний судалгаа (салбар `research/uhg-dust`)

Энэ салбар live сайтад (main, gee-data) хүрэхгүй. Сайтад нэмэх эсэхийг эзэмшигч шийднэ.

| Алхам | Файл | Хаана ажиллана |
|---|---|---|
| 1. Талбайн зураг, индексийн хүрээ | `stage1.py` | GitHub Actions + Earth Engine |
| 2. Landsat, Sentinel-2, MAIAC, ERA5-Land, MERRA-2, S5P, OSM өгөгдөл | `stage2.py` (`stages.txt`-ийн мөр бүр нэг зэрэгцээ ажил) | GitHub Actions + Earth Engine; массив нь `research/uhg-data` салбарт |
| 3. Ул мөр, FCD, салхи, DiD, эргүүлэх тест, bootstrap | `analyze.py <оролт> <гаралт>` | Аль ч компьютер (numpy, scipy) |
| 4. Зураг | `figures.py <оролт> <үр дүн> <зураг>` | matplotlib, pyproj |
| 5. Нарийвчлалын түүвэр | `accuracy_sample.py`, лавлагаа `accuracy_labels.csv` | |

Үр дүн: `results/results.json`, `results/fig/`, `results/accuracy/` (80 цэгийн зураг, тайлбар).

Анхаар: нарийвчлалын лавлагааг Sentinel-2 10 м зургийг нүдээр тайлж гаргасан (урьдчилсан). `results/accuracy/chips_*.png` зургуудыг дахин шалгаж, `accuracy_labels.csv`-ийг засна уу.
