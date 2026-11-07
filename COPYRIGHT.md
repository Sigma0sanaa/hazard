# Зохиогчийн эрхийн мэдэгдэл · Copyright notice

**Mongolia Hazard Watch · Монгол орны гамшгийн эрсдэлийн хяналт**

© 2026 Sigma0sanaa

* Төлөв / Status: хөгжүүлэлт үргэлжилж буй бүтээл / work in progress
* Вэб / Website: https://sigma0sanaa.github.io/hazard/
* Репозитори / Repository: https://github.com/Sigma0sanaa/hazard

---

## Монгол

### Эрх эзэмшигч

Sigma0sanaa бол төслийг хариуцагчийн GitHub бүртгэлийн нэр. GitHub бүртгэл эзэмшинэ гэдэг нь хуулиар тогтоогдсон зохиогч гэсэн үг биш. Зохиогч гэдэг нь бүтээлийг өөрийн оюуны бүтээлч үйл ажиллагаагаар туурвисан хувь хүн (Зохиогчийн эрхийн тухай хууль, 4.1.1) бөгөөд зохиогч мөн болохоо өөрөө нотолно (Оюуны өмчийн тухай хууль, 6.4). Энэ файлд бодит нэр бичээгүй. Хэн зохиогч, хэн эрх эзэмшигч болохыг эрх эзэмшигч өөрөө баталгаажуулна.

### Хамрах хүрээ

Энэ мэдэгдэл төслийн өөрийн анхны бүтээлд хамаарна: вэб програмын код (`index.html`, `css/`, `js/`), өгөгдөл боловсруулах код (`pipeline/`, `scripts/`), тест (`tests/`), баримт бичиг (`docs/`, `README.md`), мөн эдгээрт илэрхийлэгдсэн интерфэйс, газрын зургийн дүрслэл.

Эдгээр анхны бүтээлийн бүх эрх хуулийн хүрээнд хадгалагдана. Үүнд холбогдох лиценз болон хуулиар зөвшөөрсөн ашиглалт хамаарахгүй (Зохиогчийн эрхийн тухай хууль, 38–46 дугаар зүйл).

### Хамгаалалтад хамаарахгүй зүйл

Зохиогчийн эрх нь анхны илэрхийллийг хамгаална. Гамшгийн эрсдэлийг хянах платформ хийх ерөнхий санаа, ажиллах арга, шинжлэх ухааны онол, математикийн томьёо, тоо баримт хамгаалагдахгүй (мөн хууль, 7.1.6, 7.1.7). Энэ мэдэгдэл тэдгээрт эрх зарлахгүй.

### Албан бүртгэлийн тухай

Энэ төслийг Оюуны өмчийн газарт бүртгүүлээгүй, зохиогчийн эрхийн гэрчилгээ аваагүй, патент мэдүүлээгүй. Зохиогчийн эрх нь бүтээл бодит хэлбэрт орсон үеэс бүртгэлгүйгээр үүснэ (мөн хууль, 10.1; Оюуны өмчийн тухай хууль, 6.1, 6.2). Энэ файл бол эрхээ нийтэд мэдэгдэж буй тэмдэглэл (мөн хууль, 10.3, 10.4), хуулийн шийдвэр биш.

### Ашиглах зөвшөөрөл хүсэх

Хуулиар зөвшөөрөгдсөнөөс бусад ашиглалтад зөвшөөрөл хүснэ. Хүсэлтээ https://github.com/Sigma0sanaa/hazard/issues хаягаар гаргаж, дараахыг бичнэ үү:

1. ашиглах хэсэг (файл, хувилбар);
2. зорилго, арилжааны эсэх;
3. ашиглах хугацаа, нутаг дэвсгэр;
4. бусдад дамжуулах эсэх;
5. өөрчлөх эсэх, зохиогчийн нэрийг хэрхэн дурдах.

Зөвшөөрөл нь бичгээр эсвэл цахим хэлбэрээр байгуулсан гэрээгээр хүчин төгөлдөр болно (мөн хууль, 37.2). Issue үүсгэсэн төдийгөөр зөвшөөрөл олгогдохгүй. Зохиогчийн нэрийг дурдах, бүтээлийг гутаахгүй байх шаардлага хэвээр үлдэнэ (мөн хууль, 12 дугаар зүйл).

### Өмнө нь өгөгдсөн байж болох зөвшөөрөл

`package.json` файлд анхны коммитоос хойш `"license": "MIT"` гэж бичигдсэн, харин LICENSE файл хэзээ ч байгаагүй. Энэ мэдэгдэл нь өмнө нь хэн нэгэнд өгөгдсөн байж болох зөвшөөрлийг цуцлахгүй. Дэлгэрэнгүйг [docs/LICENSE_REVIEW.md](docs/LICENSE_REVIEW.md)-ээс үзнэ үү.

### Гуравдагч этгээдийн материал

Дараах зүйл төслийн өмч биш, өөрсдийн лиценз, нөхцөлөөр зохицуулагдана. Тэдгээрийн эрх, эх сурвалжийн нэрийг хэвээр хадгална.

| Материал | Нөхцөл |
|---|---|
| Leaflet 1.9.4 (`vendor/leaflet/`) | BSD-2-Clause, `vendor/leaflet/LICENSE` |
| NASA GIBS, FIRMS, MODIS, IMERG зураг, бүтээгдэхүүн | NASA-ийн нөхцөл, эх сурвалжийг дурдах |
| Google Earth Engine дээрх өгөгдөл: ERA5-Land, NOAA GFS, Sentinel-5P TROPOMI, MERIT Hydro, Global Flood Database, JRC Global Surface Water, MODIS | өгөгдөл бүрийн лиценз, Earth Engine-ийн нөхцөл |
| Open-Meteo, CAMS, GloFAS | Open-Meteo: CC BY 4.0, үнэгүй хэрэглээ нь арилжааны бус; CAMS, Copernicus-ийг дурдах |
| geoBoundaries (NSO Mongolia, OCHA ROAP) | CC BY 3.0 IGO |
| Natural Earth, world-atlas | нийтийн өмч, ISC |
| `data/camps.bin.gz` | Кадастрын эх өгөгдлийн лиценз батлагдаагүй. Энэ мэдэгдэлд хамаарахгүй, эрх зарлахгүй |

Бүрэн жагсаалт: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md), [docs/PROJECT_PROVENANCE.md](docs/PROJECT_PROVENANCE.md).

### Хиймэл оюуны туслалцаа

Кодын ихэнх хэсгийг Claude (Anthropic)-ын туслалцаатай бичсэн нь коммитын түүхээс харагдана. Монголын хуульд зохиогч нь хувь хүн байна. Хиймэл оюуны туслалцаатай хэсэгт зохиогчийн эрх хэрхэн тогтохыг хууль тодорхой заагаагүй тул энэ асуудлыг эрх эзэмшигч хуульчаас лавлана.

Энэ мэдэгдэл хуулийн зөвлөгөө биш.

---

## English

### Rights holder

Sigma0sanaa is the GitHub account name of the project's maintainer. Owning a GitHub account does not establish legal authorship. An author is an individual who created the work through their own intellectual creative activity (Law on Copyright of Mongolia, 4.1.1), and the author carries the burden of proving authorship (Law on Intellectual Property, 6.4). No real name is stated here. The rights holder must confirm who the author and rights holder are.

### Scope

This notice covers the project's own original contributions: the web application code (`index.html`, `css/`, `js/`), the data processing code (`pipeline/`, `scripts/`), tests (`tests/`), documentation (`docs/`, `README.md`), and the interface and map presentation expressed in them.

All rights in this original work are reserved where legally applicable, subject to applicable licenses and to uses permitted by law (Law on Copyright, Articles 38 to 46).

### What is not claimed

Copyright protects original expression. The general concept of a disaster-risk monitoring platform, operating methods, scientific theories, mathematical formulas and facts are not protected (Law on Copyright, 7.1.6 and 7.1.7), and this notice claims no rights in them.

### No official registration

This project has not been registered with the Intellectual Property Office of Mongolia, holds no copyright certificate, and has no patent application. Copyright arises without registration from the moment a work takes material form (Law on Copyright, 10.1; Law on Intellectual Property, 6.1 and 6.2). This file is a public notice of rights (Law on Copyright, 10.3 and 10.4), not a legal determination.

### Requesting permission to reuse

Uses not permitted by law need permission. Ask at https://github.com/Sigma0sanaa/hazard/issues and state:

1. what you want to use (files, version);
2. the purpose, and whether it is commercial;
3. the period and territory of use;
4. whether you will pass it on to others;
5. whether you will change it, and how the author will be credited.

Permission takes effect only through an agreement in written or electronic form (Law on Copyright, 37.2). Opening an issue grants nothing. Credit and integrity requirements remain (Article 12).

### Permissions that may already exist

`package.json` has contained `"license": "MIT"` since the first commit, while no LICENSE file has ever existed. This notice does not revoke any permission that may already have been given. See [docs/LICENSE_REVIEW.md](docs/LICENSE_REVIEW.md).

### Third-party material

The material listed in the table above belongs to others and stays under its own licenses and terms. Its rights notices and credits are kept. `data/camps.bin.gz` derives from cadastre data whose licence has not been confirmed, so it is excluded from this notice and no rights are claimed in it. Full lists: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) and [docs/PROJECT_PROVENANCE.md](docs/PROJECT_PROVENANCE.md).

### AI assistance

The commit history shows that most of the code was written with the assistance of Claude (Anthropic). Under Mongolian law an author is an individual, and the law does not say how copyright applies to AI-assisted parts, so the rights holder should take legal advice on this point.

This notice is not legal advice.
