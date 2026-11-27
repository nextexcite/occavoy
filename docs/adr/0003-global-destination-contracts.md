# ADR 0003: Global destinations with a Hong Kong customer entry point

Status: accepted product and data boundary.

## Decision

Support global destinations in the first data model, API, filters, and service-case flow. Hong Kong describes the initial audience and useful presentation defaults, not the only origin or a geographic supply restriction. Japan is a demonstration fixture.

| Concern            | Contract requirement                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| Place              | Stable ID, country/region, locality, optional coordinates and source identifiers                      |
| Time               | Local date, optional local time, precision, IANA time zone when known, and UTC instant when derivable |
| Language           | Source language and a separate display locale; preserve original text where needed                    |
| Money              | Original currency, integer minor units, appropriate currency metadata, and explicit tax/fee basis     |
| Display conversion | Separate rate source, observed time, and estimate flag; never overwrite original settlement terms     |
| Supplier           | Data-driven coverage, categories, currencies, response modes, and authority                           |
| Provenance         | Source URL or identifier, observed time, revision, and uncertainty                                    |

Do not assume every event has a precise start time, every country uses a single time zone, every currency uses two decimal places, or every supplier can sell every destination.

## Acceptance

- Reuse the same case path for a Japan and a non-Japan fixture without conditional destination code.
- Preserve a date-only event without inventing a midnight timestamp.
- Exercise a daylight-saving transition and a fractional UTC offset.
- Represent currencies with different minor-unit conventions and a mixed-currency proposal without adding raw component amounts.
- Show unsupported supply as unavailable or requiring inquiry, not as a fabricated booking option.

Country-specific fulfillment rules may be added as explicit policies. They must not redefine global representation or make the initial fixture a hidden application default.

## References

- [IANA Time Zone Database](https://www.iana.org/time-zones)
- [Unicode CLDR currency data](https://unicode.org/reports/tr35/tr35-numbers.html#Supplemental_Currency_Data)

The requirements above are project decisions. External data versions used by implementations must be pinned or recorded with their provenance.
