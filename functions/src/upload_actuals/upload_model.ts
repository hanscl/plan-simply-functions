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
    period_01?: number;
    period_02?: number;
    period_03?: number;  
    period_04?: number;
    period_05?: number;
    period_06?: number;
    period_07?: number;
    period_08?: number;
    period_09?: number; 
    period_10?: number;
    period_11?: number;
    period_12?: number;
}