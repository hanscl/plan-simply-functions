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

export interface viewTotal {
  long: string;
  short: string;
}

export interface viewPeriod {
  long: string;
  number: number;
  short: string;
}
