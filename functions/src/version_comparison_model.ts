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
  versionIds: string[];
  plansIds: string[];
  userIds: string[];
}

export interface AccountComp {
  id: string;
  level: string;
  name: string;
  values: CompRow[];
  total: CompRow;
}

export interface CompSection {
  children: AccountComp[];
  rollup: AccountComp;
}

export interface CompRow {
  base: number;
  compare: number;
  var: number;
  pct: number;
}
