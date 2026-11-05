# Daily Snow

[← README](../README.md)

Eight regional editions target **6 AM local time**. Western United States targets **7 AM Pacific / 8 AM Mountain**, synthesizing only today's available regional editions. Forecast amounts in Western are recomputed from one snapshot over matching 24/72/168-hour windows; regional article totals with different start times are context only.

## Facts before prose

`src/lib/dailysnow/facts.ts` and `digest.ts` compute eligibility, phases, forecast totals, per-area storm context, observations, continuity and available figures. Regional sources are filtered before inference. The model supplies original prose and enum-constrained figure placement in strict JSON. Code owns captions and plotted amounts.

NWS totals require complete hourly coverage and uniformly allocate interval accumulations, including fractional boundary hours. Missing coverage is unknown. Freshness checks exclude failed, old or future-dated point guidance. Old resort amounts are withheld from current model facts and totals figures.

Numerical ensemble data is verified only for Alta-Collins and remains LCC-scoped within Utah. Other regions receive NWS facts/discussions plus plume image references. Images are unseen supporting figures: models cannot read pixels or describe a particular image's spread/outcomes. Percentiles cannot be added, subtracted or divided into new forecasts.

Validation checks schemas, section/figure identities, supplied inch amounts, missing-observation claims and some unsupported image interpretations. Western also checks each region's amounts against its own structured facts. These checks cannot establish every semantic association in free prose; real outputs require review for location, period, attribution and unsupported claims.

## Scheduling and limits

Primary: `@cf/zai-org/glm-5.3-flash`. A timeout, API error or invalid result permits one fallback, `@cf/openai/gpt-oss-120b`. Each call has a five-minute timeout. Source text is untrusted input.

Automatic publication has a four-hour morning window, ten-minute retries, at most three attempts per channel/local date, and a twelve-minute lease. Successful editions are not rewritten automatically. Manual forced editions count toward the same limits. Two model requests are conservatively reserved even when the primary succeeds. The global coordinator cap is 64 per rolling 24 hours; the dedicated Gateway adds a 64-request sliding-day ceiling. At most four channels generate concurrently.

Quiet winter days still publish: November–May is a conservative initial season policy unless a source explicitly says the season is closed. Current/scheduled operations, recent operating memory or new/forecast snow can also establish activity. Fresh, quiet off-season inputs permit a pause. Missing inputs produce an expected-but-unavailable edition, not an intentional pause; automatic inference waits when no usable facts remain.

Western lists omitted regions explicitly and distinguishes missing editions from quiet off-season pauses. It never silently substitutes yesterday's article. A failed update preserves the previous edition with its date visible.

## Storms, figures and archives

Storm memory is separate for all 12 forecast areas. Reported storm totals survive source resets; earlier 24/48-hour observations keep their window and timestamp and never become storm totals. New counter segments remain separate. Tracking wraps up after 12 hours without increases plus a dry, complete near-term forecast, closes after 24 such hours, or expires after 48 hours without new evidence. Recap context lasts 36 hours after closure. These are editorial grouping rules, not measured storm onset/end.

Each article freezes its event records and figures. Mandatory per-area recaps and an available accumulated-snow plume take precedence within six figure slots. Code renders omitted supporting recaps/plumes after the prose. No image availability is invented.

Articles and figure revisions retain for 30 days from noon UTC on the edition date. Per-channel history lists the ten newest retained editions; neighbor links walk the rest. Archives and share images always include channel identity. Reads never run inference. The former resort recommendation feature is removed.

Use `npm run dailysnow:once -- --channel <id>` to inspect real inputs and validate saved model responses. See [development](DEVELOPMENT.md) for prompt tuning and [deployment](DEPLOYMENT.md) for controlled publication.
