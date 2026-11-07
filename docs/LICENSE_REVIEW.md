# Лицензийн хяналт · License review

Хянасан өдөр / Reviewed: 2026-11-08. Суурь коммит / Baseline commit: `9e444f063c43864a168a3890df063affaba0bc63`.

## Товч дүгнэлт

`package.json` дотор `"license": "MIT"` гэж бичигдсэн боловч MIT лицензийн бичвэр репозиторид хэзээ ч байгаагүй. Энэ нь зориуд сонгосон лиценз биш, анхны тохиргооноос үлдсэн мөр байх магадлалтай, гэхдээ үүнийг зөвхөн эрх эзэмшигч баталж чадна. Энэ хяналтаар `package.json`-ийг өөрчлөөгүй, MIT LICENSE файл нэмээгүй. Цаашид ямар лицензтэй байхыг эрх эзэмшигч шийднэ.

## Findings

| Fact | Evidence |
|---|---|
| `"license": "MIT"` is in `package.json` | present in every commit since the first, `e465c51` (2026-11-03) |
| `"private": true` is in the same file | the package cannot be published to npm by mistake |
| No root `LICENSE` file has ever existed | `git log --all -- LICENSE LICENSE.md LICENSE.txt` finds nothing |
| GitHub detects no license | the API reports `"license": null` |
| The README states no license for the project | it credits third parties only |
| `vendor/leaflet/LICENSE` exists | it covers Leaflet only, not this project |
| The repository is public with one fork | GitHub API, 2026-11-08 |

## Intentional or leftover?

**Not provable from the repository.** The evidence points to a leftover: the field arrived with the first scaffolding of `package.json`, next to `"private": true`, no license text or copyright line was ever added, and nothing in the README or docs mentions it. But only the rights holder knows what was intended, so this review treats it as an open question and not as a settled fact.

## Implications

* **The MIT text is missing.** MIT works by a permission text and a copyright line that must travel with the code. Neither exists here, so a reader has a one-word label and no terms.
* **The label may still have been relied on.** Anyone who read `package.json` while it said MIT could argue they took the code on those terms. The fork exists. Previous permissions must not be assumed to be revocable, and this review does not claim that they are void.
* **Mongolian law asks for form.** A licence agreement is to be made in written or electronic form with stated contents (Law on Copyright, 37.2, as amended on 2024-01-12). Whether a metadata field meets this, and how it is treated in other countries, is a question for a lawyer.
* **GitHub's own rules apply either way.** Users of GitHub may view and fork a public repository within GitHub (Terms of Service, D.5). GitHub's documentation says that without a license the default copyright laws apply.
* **A change works forward only.** A new statement can govern new versions. It should not be presented as cancelling what earlier versions said.
* **Third-party licenses do not change.** Leaflet stays BSD-2-Clause, and each data source keeps its own terms, whichever option is chosen.

## Options for the rights holder

| Option | What it means | Steps |
|---|---|---|
| A. Leave as it is for now | The label stays ambiguous | none; the question stays open in this file |
| B. All rights reserved from a stated version (recommended if control is the aim) | New versions are not offered under MIT; earlier versions keep whatever status they had | change the field to `"license": "UNLICENSED"` in a commit that states the date, the SHA and this reasoning |
| C. Open source on purpose | Others may reuse the code on known terms | choose a license deliberately, add its full text with a copyright line naming the rights holder |
| D. Split | Code and documents under different terms, for example code reserved and documentation under a Creative Commons license | state the terms per folder |

**Recommendation.** Decide first what the project is for. To keep control while it is a work in progress, use option B once the rights holder has confirmed it, and take legal advice if the code has already been reused. If open science is the priority, option C or D serves it better, and then the choice should be made on purpose instead of by leftover metadata.

This review changes no license metadata. It is not legal advice.
