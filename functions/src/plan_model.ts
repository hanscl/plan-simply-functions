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
  last_updated: admin.firestore.Timestamp;
  name: string;
  number: number;
  calculated: boolean;
  pnl_structure_id: string;
  ready_for_view?: boolean;
  child_version_ids: string[];
  is_locked: versionLockStatus;
  labor_version?: number;
  // add calendar as optional
  begin_month?: number;
  begin_year?: number;
  periods?: viewPeriod[];
  total?: viewTotal;
}

export interface planVersionCalendar {
  begin_month?: number,
  begin_year?: number,
  periods?: viewPeriod[];
  total?: viewTotal;
}

export interface versionLockStatus {
  all: boolean;
  periods: boolean[];
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
  comment?: string;
  full_account: string;
  // basic account values
  acct: string;
  acct_name: string;
  acct_type?: string;
  class: string;
  dept?: string;
  div: string;
  divdept_name: string;
  // group & rollups
  group: boolean;
  parent_rollup?: parentRollup;
  group_children?: string[];
  is_group_child: boolean;
  // values & calculation
  total: number;
  values: number[];
  calc_type?: "entry" | "driver" | "labor" | "entity_rollup";
  is_locked?: boolean;
  comments?: string;
  avg_as_total?: boolean;
}

interface parentRollup {
  acct: string;
  operation: number;
}
