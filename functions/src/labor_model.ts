export interface laborVersionDoc {
    plan_id: string;
    version_id: string;
}

export interface positionDoc {
    acct?: string;
    dept?: string;
    pos: string;
    status?: "Salary" | "Hourly";
    rate?: rateMap;
    fte_factor?: number;
    wages?: laborCalc;
    ftes?: laborCalc;
}

interface rateMap {
    annual?: number;
    hourly?: number;
}

export interface laborCalc {
    total: number;
    values: number[];
}