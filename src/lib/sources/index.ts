import { RESORTS } from "../catalog";
import { parkCitySource } from "./park-city";
import { cpcSource } from "./cpc";
import { favoriteSources } from "./favorites";
import type { SourceId } from "../types";
import { ensembleSource } from "./ensemble";
import { altaSource } from "./alta";
import { brightonSource } from "./brighton";
import { nwsSource } from "./nws";
import { nwsAfdSource } from "./nwsafd";
import { plumesSource } from "./plumes";
import { resortCamsSource } from "./resortcams";
import { snowbirdSource } from "./snowbird";
import { solitudeSource } from "./solitude";
import { taosSource } from "./taos";
import type { SourceDefinition } from "./types";

export const SOURCES: SourceDefinition[] = [
  altaSource,
  snowbirdSource,
  solitudeSource,
  brightonSource,
  parkCitySource,
  // Resort sources follow the catalog order.
  ...[...favoriteSources, taosSource].sort(
    (a, b) => RESORTS.findIndex((r) => r.id === a.id) - RESORTS.findIndex((r) => r.id === b.id),
  ),
  plumesSource,
  nwsSource,
  resortCamsSource,
  nwsAfdSource,
  ensembleSource,
  cpcSource,
] as SourceDefinition[];

export const SOURCE_BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s])) as Record<SourceId, SourceDefinition>;
