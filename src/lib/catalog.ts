/** Fixed personal favorites. Editorial regions and forecast areas are separate. */
export type TimeZone = "America/Denver" | "America/Los_Angeles";
export const REGIONS = [
  { id: "utah", name: "Utah", timeZone: "America/Denver" },
  { id: "tahoe", name: "Tahoe", timeZone: "America/Los_Angeles" },
  { id: "mammoth", name: "Mammoth", timeZone: "America/Los_Angeles" },
  { id: "tetons", name: "Tetons", timeZone: "America/Denver" },
  { id: "montana", name: "Montana", timeZone: "America/Denver" },
  { id: "colorado", name: "Colorado", timeZone: "America/Denver" },
  { id: "washington", name: "Washington", timeZone: "America/Los_Angeles" },
  { id: "oregon", name: "Oregon", timeZone: "America/Los_Angeles" },
] as const;
export type RegionId = (typeof REGIONS)[number]["id"];
export type ChannelId = RegionId | "western-us";
export const CHANNELS = [
  { id: "western-us", name: "United States West", timeZone: "America/Los_Angeles" },
  ...REGIONS,
] as const;
export const regionById = (id: string) => REGIONS.find((r) => r.id === id);
export const channelById = (id: string) => CHANNELS.find((r) => r.id === id);

export const RESORTS = [
  {
    id: "alta",
    name: "Alta",
    region: "utah",
    state: "Utah",
    canyon: "LCC",
    station: "Collins Study Plot",
    elevationFt: 9662,
  },
  {
    id: "snowbird",
    name: "Snowbird",
    region: "utah",
    state: "Utah",
    canyon: "LCC",
    station: "Official Primary report",
    elevationFt: null,
  },
  {
    id: "solitude",
    name: "Solitude",
    region: "utah",
    state: "Utah",
    canyon: "BCC",
    station: "Mid-Mountain",
    elevationFt: null,
  },
  {
    id: "brighton",
    name: "Brighton",
    region: "utah",
    state: "Utah",
    canyon: "BCC",
    station: "Official Brighton report",
    elevationFt: null,
  },
  {
    id: "park-city",
    name: "Park City",
    region: "utah",
    state: "Utah",
    canyon: "park-city",
    station: "Official resort snow report",
    elevationFt: null,
  },
  {
    id: "deer-valley",
    name: "Deer Valley",
    region: "utah",
    state: "Utah",
    canyon: "deer-valley",
    station: "Mid-Mountain",
    elevationFt: null,
  },
  {
    id: "snowbasin",
    name: "Snowbasin",
    region: "utah",
    state: "Utah",
    canyon: "snowbasin",
    station: "Official mountain report",
    elevationFt: null,
  },
  {
    id: "palisades-tahoe",
    name: "Palisades Tahoe",
    region: "tahoe",
    state: "California",
    canyon: "palisades-tahoe",
    station: "Palisades Mid-Mountain",
    elevationFt: 8000,
  },
  {
    id: "mammoth-mountain",
    name: "Mammoth Mountain",
    region: "mammoth",
    state: "California",
    canyon: "mammoth-mountain",
    station: "McCoy Station",
    elevationFt: 9600,
  },
  {
    id: "jackson-hole",
    name: "Jackson Hole",
    region: "tetons",
    state: "Wyoming",
    canyon: "jackson-hole",
    station: "Mid Mountain snow study plot",
    elevationFt: 8180,
  },
  {
    id: "big-sky",
    name: "Big Sky",
    region: "montana",
    state: "Montana",
    canyon: "big-sky",
    station: "Official resort composite (highest reported across stations)",
    elevationFt: null,
  },
  {
    id: "winter-park",
    name: "Winter Park",
    region: "colorado",
    state: "Colorado",
    canyon: "winter-park",
    station: "Mid-Mountain",
    elevationFt: null,
  },
  {
    id: "steamboat",
    name: "Steamboat",
    region: "colorado",
    state: "Colorado",
    canyon: "steamboat",
    station: "Mid-Mountain / Thunderhead",
    elevationFt: 9080,
  },
  {
    id: "telluride",
    name: "Telluride",
    region: "colorado",
    state: "Colorado",
    canyon: "telluride",
    station: "Official snow report",
    elevationFt: null,
  },
  {
    id: "crystal-mountain",
    name: "Crystal Mountain",
    region: "washington",
    state: "Washington",
    canyon: "crystal-mountain",
    station: "Mid-Mountain",
    elevationFt: null,
  },
  {
    id: "mt-bachelor",
    name: "Mt. Bachelor",
    region: "oregon",
    state: "Oregon",
    canyon: "mt-bachelor",
    station: "Official Primary report",
    elevationFt: null,
  },
] as const;
export type ResortId = (typeof RESORTS)[number]["id"];
export type ForecastAreaId = (typeof RESORTS)[number]["canyon"];
export const resortById = (id: string) => RESORTS.find((r) => r.id === id);
export const resortTimeZone = (id: string): TimeZone => regionById(resortById(id)?.region ?? "utah")!.timeZone;

/** Mountain points; /points resolves current NWS office/grid, whose elevation is shown. */
export const FORECAST_AREAS: ReadonlyArray<{
  id: ForecastAreaId;
  name: string;
  region: RegionId;
  latitude: number;
  longitude: number;
}> = [
  { id: "LCC", name: "Alta / Snowbird (LCC)", region: "utah", latitude: 40.588, longitude: -111.638 },
  { id: "BCC", name: "Brighton / Solitude (BCC)", region: "utah", latitude: 40.599, longitude: -111.583 },
  { id: "park-city", name: "Park City", region: "utah", latitude: 40.623, longitude: -111.535 },
  { id: "deer-valley", name: "Deer Valley", region: "utah", latitude: 40.61, longitude: -111.493 },
  { id: "snowbasin", name: "Snowbasin", region: "utah", latitude: 41.198, longitude: -111.86 },
  { id: "palisades-tahoe", name: "Palisades Tahoe", region: "tahoe", latitude: 39.185, longitude: -120.255 },
  { id: "mammoth-mountain", name: "Mammoth Mountain", region: "mammoth", latitude: 37.638, longitude: -119.033 },
  { id: "jackson-hole", name: "Jackson Hole", region: "tetons", latitude: 43.604, longitude: -110.866 },
  { id: "big-sky", name: "Big Sky", region: "montana", latitude: 45.277, longitude: -111.434 },
  { id: "winter-park", name: "Winter Park", region: "colorado", latitude: 39.864, longitude: -105.775 },
  { id: "steamboat", name: "Steamboat", region: "colorado", latitude: 40.459, longitude: -106.769 },
  { id: "telluride", name: "Telluride", region: "colorado", latitude: 37.922, longitude: -107.84 },
  { id: "crystal-mountain", name: "Crystal Mountain", region: "washington", latitude: 46.936, longitude: -121.479 },
  { id: "mt-bachelor", name: "Mt. Bachelor", region: "oregon", latitude: 43.994, longitude: -121.68 },
];
export const PLUME_LOCATIONS: ReadonlyArray<{ code: string; name: string; region: RegionId; note?: string }> = [
  { code: "CLN", name: "Alta-Collins, UT", region: "utah" },
  { code: "PKCU1", name: "Silver Lake Brighton, UT", region: "utah" },
  { code: "SNI", name: "Snowbasin-Mid Bowl, UT", region: "utah" },
  { code: "PALT", name: "Palisades-Tahoe Base, CA", region: "tahoe" },
  { code: "MTH04", name: "Mammoth Mt. Main Base, CA", region: "mammoth" },
  { code: "JHRV", name: "JHMR-Rendezvous Bowl, WY", region: "tetons" },
  { code: "LMTMT", name: "Big Sky-Lone Mt, MT", region: "montana" },
  {
    code: "CABTP",
    name: "Berthoud Pass, CO",
    region: "colorado",
    note: "Regional reference near Winter Park; not a resort measurement",
  },
  { code: "STORM", name: "Storm Peak Lab, CO", region: "colorado" },
  {
    code: "RMPC2",
    name: "Red Mt Pass Snotel, CO",
    region: "colorado",
    note: "San Juan regional reference; not a Telluride terrain forecast",
  },
  { code: "CMT", name: "Crystal Mt Base, WA", region: "washington" },
  { code: "MBB", name: "Mt. Bachelor Base, OR", region: "oregon" },
];

export const CAM_PAGES: Partial<Record<ResortId, string>> = {
  "park-city": "https://www.parkcitymountain.com/the-mountain/mountain-conditions/mountain-cams.aspx",
  "deer-valley": "https://www.deervalley.com/explore-the-mountain/mountain-report",
  snowbasin: "https://www.snowbasin.com/the-mountain/web-cams/",
  "palisades-tahoe": "https://www.palisadestahoe.com/mountain-information/webcams",
  "mammoth-mountain": "https://www.mammothmountain.com/on-the-mountain/mammoth-webcam",
  "jackson-hole": "https://www.jacksonhole.com/live-mountain-cams",
  "big-sky": "https://www.bigskyresort.com/current-conditions/webcams",
  "winter-park": "https://www.winterparkresort.com/the-mountain/mountain-cams",
  steamboat: "https://www.steamboat.com/the-mountain/live-cams",
  telluride: "https://tellurideskiresort.com/webcams/",
  "crystal-mountain": "https://www.crystalmountainresort.com/the-mountain/mountain-report-and-webcams/webcams",
  "mt-bachelor": "https://www.mtbachelor.com/the-mountain/webcams/",
};
