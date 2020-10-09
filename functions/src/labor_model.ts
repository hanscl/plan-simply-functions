export interface laborVersionDoc {
  plan_id: string;
  version_id: string;
}

export interface positionDoc {
  acct?: string;
  dept?: string;
  pos: string;
  status?: "Salary" | "Hourly";
  rate?: rateMap;
  fte_factor?: number;
  wages?: laborCalc;
  ftes?: laborCalc;
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
    valid_accts: { dept_id: string; acct_ids: string; }[];
  }
