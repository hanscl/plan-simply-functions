import * as admin from 'firebase-admin';

import { AccountDataRow } from './upload_model';

const db = admin.firestore();

export const validateUploadedData = async (uploadDataRequest: AccountDataRow) => {
  try {
    // check that accounts exist
    // return success or failure
    console.log(db.settings);
  } catch (error) {
    throw new Error(`Error occured in [validateUploadedData]: ${error}`);
  }
};
