import * as admin from 'firebase-admin';

import { RollVersionRequest } from './roll_version_model';

const db = admin.firestore();

export const beginRollVersion = async (rollVersionRequest: RollVersionRequest) => {
  try {
    console.log(db.settings);
  } catch (error) {
    throw new Error(`Error occured in [beginRollVersion]: ${error}`);
  }
};
