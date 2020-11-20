import * as admin from 'firebase-admin';

export interface laborVersionDoc {
  plan_id: string;
  version_id: string;
}

export interface SavePositionRequest {
  action: 'create' | 'update' | 'delete';
  entityId: string;
  planId: string;
  versionId: string;
  positionId?: string; //firstore document id
  data?: PositionData;
}

export interface PositionData {
  acct: string;
  dept: string;
  title: string;
  pay_type: 'Salary' | 'Hourly';
  rate: RateMap;
  fte_factor: number;
  ftes: LaborCalc;
  bonus_option: 'None' | 'Percent' | 'Value';
  bonus_pct?: number;
  bonus?: LaborCalc;
  socialsec_pct: number;
}

export interface PositionDoc {
  comments: string;
  acct: string;
  dept: string;
  div: string;
  title: string;
  pay_type: 'Salary' | 'Hourly';
  rate: RateMap;
  fte_factor: number;
  bonus_option: 'None' | 'Percent' | 'Value';
  bonus: LaborCalc;
  bonus_pct: number;
  wages: LaborCalc;
  ftes: LaborCalc;
  socialsec_pct: number;
  socialsec: LaborCalc;
  last_updated: admin.firestore.Timestamp;
}

export interface RateMap {
  annual?: number;
  hourly?: number;
}

export interface LaborCalc {
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
