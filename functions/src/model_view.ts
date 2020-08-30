export interface viewDoc {
  filter?: string;
  org_level: string;
  periods: viewPeriod[];
  plan_id: string;
  pnl_structure_id: string;
  title: string;
  total: viewTotal;
  version_id?: string;
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

export interface lineDoc {
    acct: string;
    child_lines?: string[];
    class: string;
    dept?: string;
    desc: string;
    div: string;
    full_account: string;
    total: number;
    values: number[];
}

export interface sectionTotal {
    desc: string;
    total: number;
    values: number[];
}

export interface sectionAcctData {
    level: string;
    operation: number;
    total: number;
    values: number[];
}

export interface sectionAccts {
    acct_data: sectionAcctData[];
    acct_ids: string[];
}

export interface sectionDoc {
    accts: sectionAccts;
    header: string;
    position: number;
    total: sectionTotal;
    child_lines?: string[];
}