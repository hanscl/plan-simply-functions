import * as functions from "firebase-functions";
export const cloudFuncLoc = functions.config().app.env === "prod" ? "us-central1" : "us-central1";
export const taskQueueLoc = functions.config().app.env === "prod" ? "europe-west1" : "us-central1";

export function getProjectId(): string | undefined {
  const fb_config = process.env.FIREBASE_CONFIG;
  if (fb_config === undefined) {
    console.log(`FIREBASE_CONFIG is undefined`);
    return undefined;
  }

  return JSON.parse(fb_config).projectId;
}

export const urlMappings = [
  { source: 'version-fullcalc-async', target: 'versionFullCalcGCT' },
  { source: 'recalc-rebuild-async', target: 'recalcRebuildVersionGCT' },
  { source: 'version-rollup-recalc', target: 'versionRollupRecalcGCT' },
  { source: 'roll-version-async', target: 'rollVersionGCT' },
  { source: 'rolling-forecast-async', target: 'rollingForecastGCT' },
  { source: 'entity-rollup-version-rebuild-recalc', target: 'entityRollupVersionRebuildRecalcGCT'}
];
