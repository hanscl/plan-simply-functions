export interface RollingForecastRequest {
    planName: string;
    sourceVersionName: string;
    targetVersionName: string;
    seedMonth: number; // 1-12 for Jan-Dec
    entityId?: string;
}

export interface RollingForecastForEntity extends RollingForecastRequest {
    entityId: string;
}