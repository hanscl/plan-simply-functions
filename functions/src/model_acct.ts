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

// IS THIS NEEDED  
  export interface parentAccounts {
    div?: accountDoc;
    dept?: accountDoc;
  }
  

  