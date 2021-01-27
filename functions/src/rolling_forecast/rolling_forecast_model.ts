export interface RollingForecastBase {
    planName: string;
    sourceVersionName: string;
    targetVersionName: string;
    seedMonth: number; // 1-12 for Jan-Dec
}

export interface RollingForecastRequest extends RollingForecastBase {
    entityIds?: string[];
}

export interface RollingForecastForEntity extends RollingForecastBase {
    entityId: string;
}