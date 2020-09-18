export interface contextParams {
  entityId: string;
  driverDocId: string;
  acctId: string;
  planId: string;
  versionId: string;
}

export interface acctDriverDef {
  driver_type: "period" | "total";
  period_spread?: number[];
  drivers: (string | number)[];
  operations: ("add" | "sub" | "mlt" | "dvs" | "pct")[];
  ref_accts?: string[];
}

export interface driverDoc {
    plan_id: string;
    version_id: string;
}

