export interface UploadTemplateRequest {
    entityId: string;
    planId: string;
    versionId: string;
}

export interface UploadTemplateCsv {
    company: string;
    cost_center: string;
    gl_acct: string;
    gl_name: string;
    full_account: string;
    period_01?: string;
    period_02?: string;
    period_03?: string;  
    period_04?: string;
    period_05?: string;
    period_06?: string;
    period_07?: string;
    period_08?: string;
    period_09?: string; 
    period_10?: string;
    period_11?: string;
    period_12?: string;
}

export interface AccountDataRow {
    company: string;
    cost_center: string;
    gl_acct: string;
    gl_name: string;
    full_account: string;
    values: any[]; // must be length = 12 
    overwriteVals: boolean[];
}


export interface UploadAccountDataRequest {
    entityId: string;
    planId: string;
    versionId: string;
    data: AccountDataRow[];
}