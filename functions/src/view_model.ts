export interface pnlStructure {
  sections: pnlSection[];
}

export interface pnlSection {
  name: string;
  header: boolean;
  total: boolean;
  lines: boolean;
  skip_levels?: number;
  filters: pnlDivFilter[];
}

interface pnlDivFilter {
  div: string[];
  rollup: string;
  operation: number;
}

export interface viewDoc {
  periods: viewPeriod[];
  plan_id: string;
  pnl_structure_id: string;
  title: string;
  total: viewTotal;
  version_id?: string;
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

export interface pnlAggregateDoc {
  child_accts: string[];
  child_ops: number[];
  total: number;
  values: number[];
  view_id: string;
}

export interface viewSection {
  name: string;
  header: boolean;
  position: number;
  totals_level?: string;
  totals_id?: string;
  lines?: viewChild[];
}

export interface viewChild {
  level: string;
  acct: string;
  desc: string;
  child_accts?: viewChild[];
}

export type viewSectionDict = {
  [k: string]: viewSection;
};

export type sectionDocRefDict = {
  [k: string]: FirebaseFirestore.DocumentReference;
};
