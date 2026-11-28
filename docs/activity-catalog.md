# Activity catalog contract and seed evidence (OCA-9)

Occavoy owns the customer-facing activity contract, participation interpretation, place/city mapping, locale handling, currency handling and any later booking or fulfilment state. Eventsquare remains the upstream discovery and evidence system. This module uses only a thin versioned projection of `eventsquare.runtime/0.1.0`; it does not import the Eventsquare runtime, mirror its database, or treat review-search results as approved inventory.

## Contract boundary

`occavoy.activity/0.1.0` is implemented in `packages/domain/src/activity.ts` and checked-in seed data is in `packages/domain/src/activity-seeds.ts`.

- `level` distinguishes concrete customer-facing `edition` and `occurrence` records. Series templates and permanent places are not activity seeds. The Eventsquare input projection still recognises `series`, `edition`, `occurrence` and `place` so unsupported levels are rejected explicitly.
- Timing precision is explicit: `unknown`, `date`, `local_datetime`, or `instant`. A date-only value is never promoted to midnight. A timezone is stored only when evidenced; there is no JST fallback.
- Event start/end, per-session start/end, walk-in opening, registration deadline and check-in deadline are separate fields. An activity can contain multiple sessions, but sessions do not count as separate seeded activities.
- `eventStatus` and raw source status/application labels are separate from `participation.applicationStatus` and from Occavoy `bookability`. `bookability` remains `not_assessed` for every real seed and no inventory is observed.
- Country/city are Occavoy-curated mappings. Prices are explicit currency plus integer minor units plus the minor-unit exponent. There is no default currency and no mixed-currency total.
- Provenance carries publisher/source/native IDs, URL, observation time, field evidence locators, retrieval method and rights notes. Real observations and synthetic fixtures use different `evidenceKind` values. Tsukuba's CC BY 4.0 attribution and adaptation note are structured fields.

## Eventsquare runtime 0.1.0 → Occavoy activity 0.1.0 mapping

| Eventsquare field                                 | Occavoy field                     | Rule                                                                                                                                                                                                                            |
| ------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `candidate.nativeId`                              | `provenance.nativeId`             | Preserved without rewriting.                                                                                                                                                                                                    |
| `candidate.names[]`                               | `titles[]`                        | Original language, script and kind are preserved.                                                                                                                                                                               |
| `candidate.level`                                 | mapping gate and `level`          | Only `occurrence` is accepted by the automated mapper; series, editions and places are rejected rather than flattened. Independently reviewed Occavoy activities may be editions when the source publishes a multi-session run. |
| `candidate.timing`                                | `schedule.start` / `schedule.end` | Precision is preserved. Date-only stays date-only. Eventsquare `endExclusive` is converted to Occavoy's inclusive source end by subtracting one day. Timezone is copied only when present.                                      |
| `candidate.status`                                | `eventStatus`                     | Normalized status only; it never implies bookability.                                                                                                                                                                           |
| `candidate.url`                                   | `provenance.sourceUrl`            | Source URL is retained.                                                                                                                                                                                                         |
| `candidate.access`                                | `participation`                   | Registration state, eligibility and access URL are carried as source claims. Occavoy application/booking state remains separate.                                                                                                |
| `candidate.claims[].evidence`                     | `provenance.fieldEvidence[]`      | Observation ID and locator are retained in compact evidence references.                                                                                                                                                         |
| record `provenance`                               | `provenance`                      | Observation time, publisher and interface are retained. Extra upstream rights/freshness/detail fields are not mirrored in this narrow projection.                                                                               |
| Eventsquare region/theme/geo/decision/search data | not imported                      | Occavoy owns country/city mapping and customer interpretation. Review-search hits are not preapproved inventory.                                                                                                                |

## Twenty-row real-seed evidence checklist

Every row is one distinct source activity record (`publisherId/nativeId` uniqueness is tested). “Evidence” means title, timing, place and status evidence locators are present in typed provenance; `isCountableSourcedOccurrence` also passes. Unknown registration, price, timezone or other unpublished facts remain unknown rather than being filled.

| #   | Activity seed                                      | Level      | Publisher / native ID                                  | Start precision | Place                                    | Source status                              | Core evidence |
| --- | -------------------------------------------------- | ---------- | ------------------------------------------------------ | --------------- | ---------------------------------------- | ------------------------------------------ | ------------- |
| 1   | `jp-tcd-1216-fantasista-marine-creatures`          | edition    | tokyo-culture-debut / `1216`                           | date            | テレコムセンタービル５階アトリウム       | 開催中                                     | yes           |
| 2   | `jp-tcd-680-national-university-print-exhibition`  | edition    | tokyo-culture-debut / `680`                            | date            | たましん美術館                           | 開催中                                     | yes           |
| 3   | `jp-tcd-830-music-workshop-festa-winter`           | edition    | tokyo-culture-debut / `830`                            | date            | 大田区民プラザ、大田区民ホール・アプリコ | 開催中 + 募集中                            | yes           |
| 4   | `jp-tcd-2642-bamboo-toy-workshop`                  | occurrence | tokyo-culture-debut / `2642`                           | local_datetime  | 江戸東京たてもの園                       | 開催中 + 募集終了                          | yes           |
| 5   | `jp-tcd-2645-building-explorers`                   | occurrence | tokyo-culture-debut / `2645`                           | local_datetime  | 江戸東京たてもの園                       | 開催中 + 募集終了                          | yes           |
| 6   | `jp-tcd-2682-tokyo-atlas-ito-no-toi`               | occurrence | tokyo-culture-debut / `2682`                           | local_datetime  | アイルしながわ、EZOHUB TOKYO             | 開催前 + 募集中                            | yes           |
| 7   | `jp-tcd-2694-shinkiba-creative-hub-2026`           | edition    | tokyo-culture-debut / `2694`                           | date            | 新木場、辰巳エリア（各参加企業の拠点）   | 開催前 + 募集中                            | yes           |
| 8   | `jp-tcd-650-nutcracker-full-length`                | edition    | tokyo-culture-debut / `650`                            | date            | 文京シビックホール 大ホール              | 開催前 + 募集中                            | yes           |
| 9   | `jp-tcd-1908-broadway-christmas-wonderland-2026`   | edition    | tokyo-culture-debut / `1908`                           | date            | 東急シアターオーブ（渋谷ヒカリエ11階）   | 開催前                                     | yes           |
| 10  | `jp-tcd-1903-sesion-christmas-family-concert`      | edition    | tokyo-culture-debut / `1903`                           | local_datetime  | セシオン杉並ホール                       | 開催前                                     | yes           |
| 11  | `jp-tcd-2566-god-hands-edo`                        | edition    | tokyo-culture-debut / `2566`                           | local_datetime  | 東京都江戸東京博物館                     | 開催前 + 募集中                            | yes           |
| 12  | `jp-tcd-1869-toy-orchestra-winter-wonderland`      | edition    | tokyo-culture-debut / `1869`                           | date            | としま区民センター                       | 開催前 + 募集中                            | yes           |
| 13  | `jp-tcd-2739-postal-museum-clay-class`             | edition    | tokyo-culture-debut / `2739`                           | local_datetime  | 郵政博物館                               | 開催前 + 募集中                            | yes           |
| 14  | `jp-tcd-835-sea-friends-workshop-concert`          | occurrence | tokyo-culture-debut / `835`                            | date            | 台東区生涯学習センター ミレニアムホール  | 開催前 + 募集中                            | yes           |
| 15  | `jp-tcd-2773-miniature-food-class`                 | occurrence | tokyo-culture-debut / `2773`                           | local_datetime  | ホテルニューオータニ ガーデンタワー 翠鳳 | 開催前 + 募集中                            | yes           |
| 16  | `jp-tcd-2596-cultural-childcare-tokyo-met-theatre` | occurrence | tokyo-culture-debut / `2596`                           | local_datetime  | 東京芸術劇場 コンサートホール            | 開催前 + 募集中                            | yes           |
| 17  | `jp-tsukuba-wakudoki-safety-festa-2026`            | edition    | city-of-tsukuba / `row-27-wakudoki-safety-festa-2026`  | local_datetime  | つくばカピオ                             | つくば市イベント情報（2026年11～12月）掲載 | yes           |
| 18  | `jp-ln-khalid-tokyo-2026-12-03`                    | occurrence | live-nation-hip-japan / `khalid-ae928417`              | local_datetime  | Tokyo Garden Theater                     | upcoming show                              | yes           |
| 19  | `jp-ln-fkj-tokyo-2026-12-10`                       | occurrence | live-nation-hip-japan / `fkj-ae1212035`                | local_datetime  | 東京国際フォーラム ホールA               | SCHEDULE掲載 + SOLD OUT                    | yes           |
| 20  | `jp-ln-against-the-current-tokyo-2027-01-13`       | occurrence | live-nation-hip-japan / `against-the-current-ae671869` | local_datetime  | Spotify O-EAST                           | SCHEDULE掲載                               | yes           |

## Portability fixtures

`activityPortabilityFixtures` contains only synthetic records and is never merged into the real seed count:

- `fixture-gb-london-dst-transition`: Europe/London, GBP, instants across the 2027 spring-forward boundary with changing offsets.
- `fixture-np-kathmandu-fractional-offset`: Asia/Kathmandu local time and a three-decimal BHD amount.
- `fixture-hk-mixed-currency-date-only`: Asia/Hong_Kong date-only timing plus separate HKD and EUR components with no raw summed total.

## Source-use notes

The Tokyo Culture Debut and Live Nation records were manually read once from public first-party detail pages on 2026-11-28 UTC. Only concise factual metadata is checked in; long descriptions, images and creative text were not copied. Those pages are not recurring-acquisition or redistribution licences. The Tsukuba seed reuses the Eventsquare scoped projection receipt and workbook cell evidence. Its attribution is “City of Tsukuba”; it is an adapted factual projection under CC BY 4.0. The source workbook does not declare a timezone, so no timezone is stored.

The web home page renders a small sample of real seeds with the visible label “Real public source · not bookable inventory” and states that non-Japan/DST/currency examples are synthetic portability fixtures, not real inventory.
