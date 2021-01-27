interface RollVersionBase {
  sourcePlanVersion: PlanVersion;
  targetPlanVersion: PlanVersion;
  copyDrivers: boolean;
  copyLaborPositions: boolean;
  lockSourceVersion: boolean;
}

export interface RollVersionRequest extends RollVersionBase {
  entityIds?: string;
}

export interface RollVersionForEntity extends RollVersionBase {
  entityId: string;
}

export interface PlanVersion {
  planName: string;
  versionName: string;
}

interface CompanyPlanDefinition {
  name: string;
  type: string;
  versions: string[];
}

export interface CompanyPlanDocment {
  plans: CompanyPlanDefinition[];
}
