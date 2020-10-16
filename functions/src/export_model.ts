import * as admin from "firebase-admin";

export interface reportDoc {
    created_at: admin.firestore.Timestamp;
    output: "csv" | "xls" | "pdf";
    path: { entity: string; div?: string; dept?: string };
    plan_id: string;
    plan_name: string;
    version_id: string;
    version_name: string;
    status: "processing" | "complete" | "error";
    type: "accounts" | "pnl";
}

export interface acctExportCsv {
    company: string;
    cost_center: string;
    gl_acct: string;
    gl_name: string;
    full_account: string;
    p01?: number;
    p02?: number;
    p03?: number;  
    p04?: number;
    p05?: number;
    p06?: number;
    p07?: number;
    p08?: number;
    p09?: number; 
    p10?: number;
    p11?: number;
    p12?: number;
}