# Offer Detail 118-record historical gap diagnostic

This offline diagnostic freezes the only conclusion supported by the retained
historical metadata. The old cohort recorded 118 completed Offer Detail rows,
but ShopCard parsed 113, Consignment was observed for 113 and parsed for 111,
and only 107 rows parsed both sources.

The version-controlled manifest is
`tests/fixtures/offer-detail-diagnostic/118-gap-manifest.json`. It lists every
affected Offer/source pair. None of those rows has a sanitized raw response ref
in the approved fixture set, so every item is classified
`historical_evidence_insufficient` and its expected V2 terminal state is
`failed`. This is deliberately not guessed into `not-present`.

The production Gate remains blocked for these historical rows. A controlled,
authorized recollection must establish a new immutable source receipt with
response observation, success, Offer/member correlation, parser revision, raw
artifact ref and either parsed data or a versioned successful-empty absence
proof. New evidence cannot retroactively change the old receipt.

The runtime regression tests cover the resulting rule: response absence,
timeout, schema/parse failure and correlation failure remain technical failure;
only a successful correlated empty sentinel can produce `not-present`.
