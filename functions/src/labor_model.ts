export interface laborVersionDoc {
  plan_id: string;
  version_id: string;
}

export interface SavePositionRequest {
  action: "create" | "update" | "delete";
  entityId: string;
  versionId: string;
  positionId?: string; //firstore document id
  data?: PositionData;
}

export interface PositionData {
  acct: string;
  dept: string;
  pos: string;
  status: "Salary" | "Hourly";
  rate: { annual?: number; hourly?: number };
  fte_factor: number;
  bonus_option: "None" | "Percent" | "Value";
  bonus?: laborCalc;
  socialsec_pct: number;
}

export interface positionDoc {
  acct?: string;
  dept?: string;
  div?: string; // for filtering only - do not display in UI
  pos: string;
  status?: "Salary" | "Hourly";
  rate?: rateMap;
  fte_factor?: number;
  bonus_option?: "None" | "Percent" | "Value";
  bonus?: laborCalc;
  wages?: laborCalc;
  ftes?: laborCalc;
  socialsec_pct?: number;
  socialsec: laborCalc;
  //is_updating?: boolean;
}

interface rateMap {
  annual?: number;
  hourly?: number;
}

export interface laborCalc {
  total: number;
  values: number[];
}

export interface laborValidationRequest {
  version_id: string;
  plan_id: string;
  path: { entity: string; div?: string; dept?: string };
}

export interface laborValidationResponse {
  valid_depts: string[];
  valid_accts: { dept_id: string; acct_ids: string[] }[];
}

export interface laborValidationResponseAlt {
  valid_depts: string[];
  valid_accts: { dept_id: string; acct_ids: string }[];
}
