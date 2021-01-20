import * as admin from 'firebase-admin';

import { RollingForecastRequest } from './rolling_forecast_model';

const db = admin.firestore();

export const beginRollingForecast = async (rollingForecastRequest: RollingForecastRequest) => {
  try {
      console.log(db.settings);
  } catch (error) {
    throw new Error(`Error occured in [beginRollingForecast]: ${error}`);
  }
};
