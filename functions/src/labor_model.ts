import * as admin from "firebase-admin";

export interface laborVersionDoc {
  plan_id: string;
  version_id: string;
}

export interface SavePositionRequest {
  action: "create" | "update" | "delete";
  entityId: string;
  planId: string;
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
  ftes: number[];
  bonus_option: "None" | "Percent" | "Value";
  bonus_pct?: number;
  bonus?: number[];
  socialsec_pct: number;
}

export interface PositionDoc {
  acct: string;
  dept: string;
  div: string; 
  pos: string;
  wage_type: "Salary" | "Hourly";
  status?: "Salary" | "Hourly"; // TODO: REMOVE WHEN PROD POSITIONS HAVE BEEN UPDATED
  rate: rateMap;
  fte_factor: number;
  bonus_option: "None" | "Percent" | "Value";
  bonus: laborCalc;
  bonus_pct: number;
  wages: laborCalc;
  ftes: laborCalc;
  socialsec_pct: number;
  socialsec: laborCalc;
  last_updated: admin.firestore.Timestamp;
}

export interface rateMap {
  annual: number;
  hourly: number;
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
