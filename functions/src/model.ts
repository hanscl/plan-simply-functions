export interface parentRollup {
    acct: string;
    operation: number;
  }
  
  export interface accountDoc {
    acct: string;
    acct_type?: string;
    class: string;
    dept?: string;
    div: string;
    full_account: string;
    parent_rollup?: parentRollup;
    total: number;
    values: number[];
  }
  
  export interface lineDoc extends accountDoc {
    desc: string;
    child_lines?: string[];
  }
  
  export interface parentAccounts {
    div?: accountDoc;
    dept?: accountDoc;
  }
  
  export interface sectionDoc {
    accts: acctsMap;
    position: number;
    total: totalMap;
  }
  
  export interface totalMap {
    desc: string;
    total: number;
    values: number[];
  }
  
  export interface acctsMap {
    acct_data: acctData[];
    acct_ids: string[];
  }
  
  export interface acctData {
    operation: number;
    total: number;
    values: number[];
  }
  