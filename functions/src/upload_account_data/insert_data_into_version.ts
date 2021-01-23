import * as admin from 'firebase-admin';
import {dispatchGCloudTask} from '../gcloud_task_dispatch';

import { accountDoc } from '../plan_model';

import { UploadAccountDataRequest } from './upload_model';

const db = admin.firestore();

export const validateUploadedData = async (uploadDataRequest: UploadAccountDataRequest) => {
  try {
    const versionDocRef = db.doc(
      `entities/${uploadDataRequest.entityId}/plans/${uploadDataRequest.planId}/versions/${uploadDataRequest.versionId}`
    );
    const nLevelAccountQuerySnap = await versionDocRef.collection(`dept`).where('class', '==', 'acct').get();

    const validAccounts: string[] = [];
    for (const nLevelAccountDoc of nLevelAccountQuerySnap.docs) {
      validAccounts.push((nLevelAccountDoc.data() as accountDoc).full_account);
    }

    // make sure all accounts are valid
    const invalidAccounts = uploadDataRequest.data.filter(
      (accountRow) => !validAccounts.includes(accountRow.full_account)
    );

    if (invalidAccounts.length > 0) {
      throw new Error(
        `Upload attempt aborted. The following accounts do not exist in the plan: ${JSON.stringify(
          invalidAccounts.map((acct) => acct.full_account)
        )}`
      );
    }

    // confirm that all values are numbers
    const nanAccountRows = uploadDataRequest.data.filter(
      (accountRow) => !accountRow.values.every((val) => !isNaN(val))
    );

    if (nanAccountRows.length > 0) {
      throw new Error(
        `Upload attempt aborted. The following accounts do not exist in the plan: ${JSON.stringify(
          invalidAccounts.map((acct) => acct.full_account)
        )}`
      );
    }

    // we're good, let's upload => schedule the cloud tasks
     await dispatchGCloudTask(recalcReq, 'version-rollup-recalc', 'recalc');

    // check that accounts exist
    // return success or failure
    console.log(db.settings);
  } catch (error) {
    throw new Error(`Error occured in [validateUploadedData]: ${error}`);
  }
};
