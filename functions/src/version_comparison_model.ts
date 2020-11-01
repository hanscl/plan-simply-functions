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
