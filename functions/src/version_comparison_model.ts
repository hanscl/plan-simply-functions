import * as admin from "firebase-admin";

export interface VersionComp {
  entityId: string;
  baseVersion: PlanVersion;
  compareVersion: PlanVersion;
}

export interface VersionCompWithUser extends VersionComp {
  userId: string;
}

interface PlanVersion {
  versionId: string;
  planId: string;
}

export interface VersionCompDocument {
  version_ids: string[];
  plan_ids: string[];
  last_updated: admin.firestore.Timestamp;
  last_accessed: admin.firestore.Timestamp;
  ready: boolean; 
}

export interface CompSection {
  children: AccountComp[];
  rollup: AccountComp;
}

export interface AccountComp {
  id: string;
  level: string;
  name: string;
  values: CompRow[];
  total: CompRow;
}

export interface CompRow {
  base: number;
  compare: number;
  var: number;
  pct: number;
}
