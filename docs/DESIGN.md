# Design

[← README](../README.md)

The web app serves phones and laptop browsers in light and dark themes. Appearance preferences use the Mitchell's storage prefix. The masthead and four main tabs remain shared across pages; resort detail pages use the same single tab row, with Resorts marked as their parent. Resort links live on the homepage.

Long-form resort reports and Daily Snow are page content with one reading width, no enclosing card border, and aligned child edges. Pale panels are reserved for summaries and charts. AI prose carries the AI badge and model footer, separate from measured and forecast data.

The Resorts page shows all 16 favorites in fixed order, with unchanged resort names, geographic labels, past-week history, current 24-hour report and seven forecast days. The "Next 7 days" label carries the NWS forecast total for those days (current day's remaining hours included); when NWS ends before the seventh day the label counts the days the total covers, and with no forecast the total is —. Each timeline is one keyboard stop linking to its detail page. It has no recommendation or article teaser. Reported snow is solid, forecasts striped, past starting forecasts outlined, zero muted, and missing/unrecorded states explicit.

Snow days end at 6 AM destination local time. Source measurement windows remain unchanged. Report provenance belongs on detail pages, including fixed reporting station, verified elevation and composite exceptions. All resort pages share the same window order and sections, while unavailable optional measurements remain unavailable.

Daily Snow, Weather and Plumes have a compact native region dropdown above their heading. The Region label is available to assistive technology; no visible label sits beside the dropdown. URLs identify the selection; explicit links override saved preferences. Weather and Plumes remember a regional choice; selecting Western Daily Snow preserves it. Native selects support keyboard operation. United States West is a standalone article with broad-pattern, near-term and extended sections plus frozen NWS comparison figures. The dropdown provides access to regional editions; the article discloses omitted coverage without linking to other reports. Weather uses two columns with an odd final point spanning the row. Plumes group panels by station in two columns, with a single or odd final station showing its panels side by side; phones stack all content.

Forecast tables and six-hour charts scroll inside their own containers. Timelines retain all 15 columns on phone widths; headers align name/region and report time. Plume charts use white ground, destination-local day boundaries and a now/posted marker. Original fallback charts retain UTC labels and true station names, including base and nearby reference stations.

Loading placeholders announce status and honor reduced motion. The shared shell retains data through background polling failures. Daily Snow archive switches keep the visible article while loading; links, caches and images are scoped by channel.
