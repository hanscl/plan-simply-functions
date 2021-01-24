import * as admin from 'firebase-admin';
import { accountDoc } from '../plan_model';

import { UploadAccountDataRequest } from './upload_model';

const db = admin.firestore();

export const validateUploadedData = async (uploadDataRequest: UploadAccountDataRequest) => {
  try {
    console.log(`entities/${uploadDataRequest.entityId}/plans/${uploadDataRequest.planId}/versions/${uploadDataRequest.versionId}`);
    const versionDocRef = db.doc(
      `entities/${uploadDataRequest.entityId}/plans/${uploadDataRequest.planId}/versions/${uploadDataRequest.versionId}`
    );

    const nLevelAccountQuerySnap = await versionDocRef.collection(`dept`).where('class', '==', 'acct').get();

    const validAccounts: string[] = [];
    const driverLaborAccounts: string[] = [];
    for (const nLevelAccountDoc of nLevelAccountQuerySnap.docs) {
      const account = nLevelAccountDoc.data() as accountDoc;
      validAccounts.push(account.full_account);
      if (account.calc_type && account.calc_type !== 'entry') {
        driverLaborAccounts.push(account.full_account);
      }
    }

    // make sure all accounts are valid
    const invalidAccounts = uploadDataRequest.data.filter(
      (accountRow) => !validAccounts.includes(accountRow.full_account)
    );


    if (invalidAccounts.length > 0) {
      return {
        status: 'ERROR',
        message: `Cannot upload data: The following accounts do not exist in the plan: ${JSON.stringify(
          invalidAccounts.map((acct) => acct.full_account)
        )}`,
      };
    }

    // confirm that all values are numbers
    const nanAccountRows = uploadDataRequest.data.filter(
      (accountRow) => !accountRow.values.every((val) => !isNaN(val))
    );

    if (nanAccountRows.length > 0) {
      return {
        status: 'ERROR',
        message: `Cannot upload data: The following accounts contain non-numeric values: ${JSON.stringify(
          nanAccountRows.map((acct) => acct.full_account)
        )}`,
      };
    }

    // check if any accounts are labor or driver calc that would be overwritten
    const uploadAccountsIntoDriverLabor = uploadDataRequest.data.filter((row) =>
      driverLaborAccounts.includes(row.full_account)
    );
    if (uploadAccountsIntoDriverLabor.length > 0) {
      return {
        status: 'WARNING',
        message: `The following accounts are currently dynamically calculated. Uploading your data will remove the will overwrite the values and remove associated driver or labor positions: ${JSON.stringify(
          uploadAccountsIntoDriverLabor.map((acct) => acct.full_account)
        )}`,
      };
    }

    return {status: 'OK', message: 'Validation successful. Proceed with upload.'};
  } catch (error) {
    throw new Error(`Error occured in [validateUploadedData]: ${error}`);
  }
};
