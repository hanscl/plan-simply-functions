export interface RollVersionRequest {
  sourcePlanVersion: PlanVersion;
  targetPlanVersion: PlanVersion;
  copyDrivers: boolean;
  copyLaborPositions: boolean;
  lockSourceVersion: boolean;
  entityId?: string;
}

interface PlanVersion {
  planName: string;
  versionName: string;
}
