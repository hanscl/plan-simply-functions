export interface contextParams {
  entityId: string;
  driverDocId: string;
  acctId: string;
  planId: string;
  versionId: string;
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
  comment?: string;
}

export interface driverDoc {
    plan_id: string;
    version_id: string;
}

