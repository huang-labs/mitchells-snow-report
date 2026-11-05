# Daily Snow

[← README](../README.md)

Eight regional editions target **6 AM local time**. United States West targets **7 AM Pacific / 8 AM Mountain**, using today's available regional editions as context for an original article about the overall pattern, near-term weather and extended outlook. It has no regional article links or per-region highlight list; the page selector provides regional navigation. Its sections form one timeline: Overview, Short Term Forecast (days 1–7) and Extended Forecast (days 8–14). Forecast amounts in Western are recomputed from one snapshot over matching windows (days 1–3 and the following 96 hours); regional article totals with different start times are context only. Extended Forecast is grounded in NOAA's Climate Prediction Center 8–14-day 500-mb height outlook (`src/lib/sources/cpc.ts`), and Short Term Forecast also receives the same issue's 6–10-day discussion to bridge days 4–7 into week two. The collector accepts an issue only when the map page and written discussion agree on issue date and valid window, the 6–10-day window starts two days before week two, checks the GIF, and stores it in KV by content hash. The model reads clipped copies of both discussions; the map itself is copied into the post as a figure. A failed, stale (over 48 hours), already-started or missing outlook leaves Extended Forecast as brief prose without the map.

## Facts before prose

`src/lib/dailysnow/facts.ts` and `digest.ts` compute eligibility, phases, forecast totals, per-area storm context, observations, continuity and available figures. Regional sources are filtered before inference. The model supplies original prose and enum-constrained figure placement in strict JSON. Code owns captions and plotted amounts.

NWS totals require complete hourly coverage and uniformly allocate interval accumulations, including fractional boundary hours. Missing coverage is unknown. Freshness checks exclude failed, old or future-dated point guidance. Old resort amounts are withheld from current model facts and totals figures.

Numerical ensemble data is verified only for Alta-Collins and remains LCC-scoped within Utah. Other regions receive NWS facts/discussions plus plume image references. Images are unseen supporting figures: models cannot read pixels or describe a particular image's spread/outcomes. Percentiles cannot be added, subtracted or divided into new forecasts.

Daily Snow preserves source references such as “the discussion” in generated and archived prose; it does not rewrite them to “the NWS”.

Validation checks schemas, section/figure identities, supplied inch amounts, missing-observation claims and some unsupported image interpretations. United States West leaves all snowfall amounts to code-drawn figures and rejects numerical snowfall amounts and links in model prose. It targets 450–600 words (regional editions stay at about 250–450) with per-section budgets of about 125, 200 and 175; an article over 650 words is rejected so the fallback model gets a turn. Figures follow the last paragraph of their section, and the model may refer to a figure only there. One frozen figure compares NWS mountain points in two consecutive columns, days 1–3 and days 4–7, retaining issue times, matching windows, zeros and missing coverage separately; the NOAA pattern map follows the extended section with a code-written caption naming its valid window and issue time. These checks cannot establish every semantic association in free prose; real outputs require review for location, period, attribution and unsupported claims.

## Scheduling and limits

Primary: `@cf/zai-org/glm-5.3-flash`. A timeout, API error or invalid result permits one fallback, `@cf/openai/gpt-oss-120b`. Each call has a five-minute timeout. Source text is untrusted input.

Automatic publication has a four-hour morning window, ten-minute retries, at most three attempts per channel/local date, and a twelve-minute in-flight window. Each channel's state in KV records these; there is no separate lock. Successful editions are not rewritten automatically. Manual forced editions count toward the same limits and are refused while that channel's attempt is in flight. Two model requests are conservatively recorded even when the primary succeeds, so nine channels can use at most 54 per local day. The dedicated Gateway's 64-request sliding-day limit is the hard ceiling. At most four regional channels generate concurrently, counting attempts still running from an earlier cron.

Quiet winter days still publish: November–May is a conservative initial season policy unless a source explicitly says the season is closed. Current/scheduled operations, recent operating memory or new/forecast snow can also establish activity. Fresh, quiet off-season inputs permit a pause. Missing inputs produce an expected-but-unavailable edition, not an intentional pause; automatic inference waits when no usable facts remain.

Western lists omitted regions explicitly and distinguishes missing editions from quiet off-season pauses. It never silently substitutes yesterday's article. A failed update preserves the previous edition with its date visible.

## Storms, figures and archives

Storm memory is separate for all 12 forecast areas. Reported storm totals survive source resets; earlier 24/48-hour observations keep their window and timestamp and never become storm totals. New counter segments remain separate. Tracking wraps up after 12 hours without increases plus a dry, complete near-term forecast, closes after 24 such hours, or expires after 48 hours without new evidence. Recap context lasts 36 hours after closure. These are editorial grouping rules, not measured storm onset/end.

Each article freezes its event records and figures. Mandatory per-area recaps and an available accumulated-snow plume take precedence within six figure slots. Code renders omitted supporting recaps/plumes after the prose. No image availability is invented.

Articles and figure revisions retain for 30 days from noon UTC on the edition date. Per-channel history lists the ten newest retained editions; neighbor links walk the rest. Archives and share images always include channel identity. Reads never run inference. The former resort recommendation feature is removed.

Use `npm run dailysnow:once -- --channel <id>` to inspect real inputs and validate saved model responses. See [development](DEVELOPMENT.md) for prompt tuning and [deployment](DEPLOYMENT.md) for controlled publication.
