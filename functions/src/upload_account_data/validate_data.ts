import * as admin from 'firebase-admin';
import { accountDoc } from '../plan_model';

import { UploadAccountDataRequest, AccountDataRow } from './upload_model';

const db = admin.firestore();

export const validateUploadedData = async (uploadDataRequest: UploadAccountDataRequest) => {
  try {
    console.log(
      `entities/${uploadDataRequest.entityId}/plans/${uploadDataRequest.planId}/versions/${uploadDataRequest.versionId}`
    );
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
    console.log(
      `Accounts found for check. [1] Itemized Entry: ${validAccounts}, [2] Driver or Labor: ${driverLaborAccounts}`
    );

    // Drop the header row for processing
    const headerRow = uploadDataRequest.data.splice(0,1);

    // make sure all accounts are valid
    const invalidAccounts = uploadDataRequest.data.filter(
      (accountRow) =>
        !(validAccounts.includes(accountRow.full_account) || driverLaborAccounts.includes(accountRow.full_account))
    );

    console.log(`Array of invalid accounts: ${JSON.stringify(invalidAccounts)}`);

    if (invalidAccounts.length > 0) {
      return {
        status: 'ERROR',
        message: `Cannot upload data: The following accounts do not exist in the plan: ${JSON.stringify(
          invalidAccounts.map((acct) => acct.full_account)
        )}`,
      };
    }

    // confirm that all values are numbers
    const nanAccountRows = uploadDataRequest.data.filter((accountRow) => {
      const everyResult = accountRow.values.every((val) => val === null || typeof val === 'number');
      console.log(`RESULT of every: ${everyResult}`);
      return !everyResult;
    });

    console.log(`Array of rows with at least one NaN: ${JSON.stringify(nanAccountRows)}`);

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

    console.log(
      `Driver or Labor accounts to be overwritten with values: ${JSON.stringify(uploadAccountsIntoDriverLabor)}`
    );

    if (uploadAccountsIntoDriverLabor.length > 0) {
      return {
        status: 'ERROR',
        message: `The following accounts are currently dynamically calculated and cannot be overwritten via upload: ${JSON.stringify(
          uploadAccountsIntoDriverLabor.map((acct) => acct.full_account)
        )}`,
      };
    }

    // initialize val overwrite flags to false
    uploadDataRequest.data.forEach((row) => {
      row.overwriteVals = [true, true, true, true, true, true, true, true, true, true, true, true];
    });

    // No errors; now merge any partial rows with existing values
    await checkAndMergeAccountRows(uploadDataRequest);

    // re-insert header row before returning to client
    const dataToReturn = headerRow.concat(uploadDataRequest.data);

    console.log(`Returning the following data to client ${JSON.stringify(dataToReturn)}`);

    return { status: 'OK', message: 'Validation successful. Proceed with upload.', data: dataToReturn };
  } catch (error) {
    throw new Error(`Error occured in [validateUploadedData]: ${error}`);
  }
};

const checkAndMergeAccountRows = async (uploadDataRequest: UploadAccountDataRequest) => {
  // filter account rows for null vals
  const rowsWithOneOrMoreNullVals = uploadDataRequest.data.filter(
    (accountRow) => !accountRow.values.every((val) => val !== null)
  );

  // query accounts in batches of 10, merge with the upload request and set the flags array
  for (let rowIdx = 0; rowIdx < rowsWithOneOrMoreNullVals.length; rowIdx += 10) {
    const filteredAcctRows = rowsWithOneOrMoreNullVals.slice(
      rowIdx,
      Math.min(rowIdx + 10, rowsWithOneOrMoreNullVals.length)
    );

    const acctNumbersToFilter = filteredAcctRows.map((acctrow) => acctrow.full_account);

    const acctQuerySnap = await db
      .collection(
        `entities/${uploadDataRequest.entityId}/plans/${uploadDataRequest.planId}/versions/${uploadDataRequest.versionId}/dept`
      )
      .where('full_account', 'in', acctNumbersToFilter)
      .get();

    for (const acctDoc of acctQuerySnap.docs) {
      mergeAccountRow(filteredAcctRows, acctDoc.data() as accountDoc);
    }
  }
};

const mergeAccountRow = (uploadDataRows: AccountDataRow[], account: accountDoc) => {
  const dataRowsToUpdate = uploadDataRows.filter(row => row.full_account === account.full_account);

  if(dataRowsToUpdate.length !== 1) {
    throw new Error('Must find exactly one account match per row.')
  }

  let nullValIndex =  dataRowsToUpdate[0].values.indexOf(null);

  while(nullValIndex > -1 ) {
    dataRowsToUpdate[0].values[nullValIndex] = account.values[nullValIndex];
    dataRowsToUpdate[0].overwriteVals[nullValIndex] = false;
    nullValIndex = dataRowsToUpdate[0].values.indexOf(null, nullValIndex + 1);
  }
};
