export interface CalcRequest {
  entityId: string;
  planId: string;
  versionId: string;
}

export type AccountCalculationType = typeof accountTypes[number];
export const divDeptLevelsOnly = ['dept', 'div'] as const;
const allAccountLevels = [...divDeptLevelsOnly, 'pnl'] as const;
export const accountTypes = [...allAccountLevels, 'group', 'driver'] as const;
type AccountLevel = typeof allAccountLevels[number];
type TypeToLevelDict = {
  [k in AccountCalculationType]: AccountLevel;
};

export const mapTypeToLevel: TypeToLevelDict = {
  pnl: 'pnl',
  div: 'div',
  dept: 'dept',
  driver: 'dept',
  group: 'dept',
};

