export interface RollVersionRequest {
  sourcePlanVersion: PlanVersion;
  targetPlanVersion: PlanVersion;
  copyDrivers: boolean;
  copyLaborPositions: boolean;
  lockSourceVersion: boolean;
}

interface PlanVersion {
  planName: string;
  versionName: string;
}
