import { rebuildVersionHierarchy } from './version_calc/version_hierarchy_rebuild';
import { versionFullCalc } from './version_calc/version_fullcalc';
import { planViewGenerateCalled } from './plan_view_generate';

export const completeRebuildAndRecalcVersion = async (entityPlanVersion: {
  entityId: string;
  planId: string;
  versionId: string;
}) => {
  await rebuildVersionHierarchy(entityPlanVersion);
  await planViewGenerateCalled(entityPlanVersion);
  await versionFullCalc(entityPlanVersion);
};
