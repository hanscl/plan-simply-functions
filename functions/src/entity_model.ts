export interface entityDoc {
  children?: string[];
  name: string;
  number?: string;
  legal?: string;
  full_account: string;
  div_account?: string;
  full_account_export: string;
  acct_type_flip_sign?: string[];
}

export interface acctMap {
  name: string;
  type: string;
  depts: string[];
}

export interface deptMap {
  div: string;
  name: string;
}

export interface divMap {
  depts: string[];
  name: string;
}

export type acctDict = {
  [k: string]: acctMap;
};

export type deptDict = {
  [k: string]: deptMap;
};

export type divDict = {
  [k: string]: divMap;
};

export interface groupDoc {
  children: string[];
  code: string;
  level: string;
  name: string;
  div: string;
}

export interface acctComponents {
  dept?: string;
  div: string;
  acct: string;
}

export interface rollupDoc {
  level: number;
  n_level: boolean;
  rollup: string;
  child_rollups?: { [k: string]: number };
  acct_types?: string[];
  accts_add?: string[];
  accts_remove?: string[];
}

export interface hierDoc {
  children: hierLevel[];
}

export interface hierLevel {
  level: string;
  name: string;
  id: string;
  children?: hierLevel[];
}
