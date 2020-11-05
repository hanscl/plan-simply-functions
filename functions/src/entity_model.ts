export interface entityDoc {
  children?: string[];
  name: string;
  number: string;
  legal: string;
  full_account: string;
  div_account: string;
  full_account_export: string;
  acct_type_flip_sign?: string[];
  type: string;
  entity_embeds?: entityEmbed[]; 
  labor_calcs?: laborCalcs;
}

export interface laborCalcs {
  default_accts: {
    bonus: string;
    socialsec: string;
    }
  socialsec_pct?: number;
  wage_method: "eu" | "us";
}

export interface entityEmbed {
  field: string;
  pos: number;
}

export interface acctMap {
  name: string;
  type: string;
  depts: string[];
}

export interface deptMap {
  div?: string;
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

export interface groupObj {
  children: string[];
  code: string;
  level: string;
  name: string;
  div: string;
}

export interface groupDoc {
  groups: groupObj[];
}

export interface acctComponents {
  dept?: string;
  div: string;
  acct: string;
}

export interface rollupObj {
  level: number;
  n_level: boolean;
  rollup: string;
  child_rollups?: { [k: string]: number };
  acct_types?: string[];
  accts_add?: string[];
  accts_remove?: string[];
}

export interface rollupSummaryDoc {
  name: string;
  max_level: number;
  items: rollupNameMap[];
}

export interface rollupNameMap {
  name: string;
  code: string;
}

export interface hierDoc {
  children: hierLevel[];
  ready_for_rollup?: boolean;
}

export interface hierLevel {
  level: string;
  name: string;
  id: string;
  children?: hierLevel[];
}

