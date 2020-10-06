import * as admin from "firebase-admin";

export interface planDoc {
  account_rollup: string;
  begin_month: number;
  begin_year: number;
  created: admin.firestore.Timestamp;
  name: string;
  periods: viewPeriod[];
  total: viewTotal;
  type: string;
}

export interface versionDoc {
  last_update: admin.firestore.Timestamp;
  name: string;
  number: number;
  calculated: boolean;
  pnl_structure_id: string;
  ready_for_view?: boolean;
  child_version_ids: string[];
}

interface viewTotal {
  long: string;
  short: string;
}

interface viewPeriod {
  long: string;
  number: number;
  short: string;
}

export interface accountDoc {
  acct: string;
  acct_name: string;
  acct_type?: string;
  class: string;
  dept?: string;
  div: string;
  divdept_name: string;
  group: boolean;
  full_account: string;
  parent_rollup?: parentRollup;
  total: number;
  values: number[];
  group_children?: string[];
  is_group_child: boolean;
  calc_type: "entry" | "driver" | "labor" | "ref";
}

interface parentRollup {
  acct: string;
  operation: number;
}
