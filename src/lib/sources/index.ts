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
import type { SourceDefinition } from "./types";

export const SOURCES: SourceDefinition[] = [
  altaSource,
  snowbirdSource,
  solitudeSource,
  brightonSource,
  ...favoriteSources,
  plumesSource,
  nwsSource,
  resortCamsSource,
  nwsAfdSource,
  ensembleSource,
  cpcSource,
] as SourceDefinition[];

export const SOURCE_BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s])) as Record<SourceId, SourceDefinition>;
