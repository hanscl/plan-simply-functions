import * as view_model from "./view_model";

export interface driverParamsContext {
  entity_id: string;
  version_id: string;
  acct_id: string;
}

export interface driverParamsAll extends driverParamsContext {
  plan_id: string;
}

export interface driverAcct {
  level:("div" | "dept" | "pnl");
  id: string;
}

export interface driverEntry {
  type: ("acct" | "value");
  entry: number[] | driverAcct;
}

export interface acctDriverDef {
  drivers: driverEntry[];
  operations: ("add" | "sub" | "mlt" | "dvs" | "pct")[];
  ref_accts?: string[]; 
  comments?: string;
}

export interface driverDoc {
    plan_id: string;
    version_id: string;
}

export interface validDriverAccts {
  entity: string;
  account: string;
  version_id: string;
  plan_id: string;
  sections?: view_model.viewSection[];
}
