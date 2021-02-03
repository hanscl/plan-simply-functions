import * as admin from 'firebase-admin';
import { accountDoc } from '../plan_model';

import { AccountDataRow, UploadAccountDataRequest } from './upload_model';

const db = admin.firestore();

type AcctCheck = {
  fullAccount: string;
  calcType?: 'entry' | 'driver' | 'labor' | 'entity_rollup';
};

export const insertDataIntoVersion = async (uploadDataRequest: UploadAccountDataRequest) => {
  try {
    const versionRef = db.doc(
      `entities/${uploadDataRequest.entityId}/plans/${uploadDataRequest.planId}/versions/${uploadDataRequest.versionId}`
    );

    const laborPosRef = db.doc(`entities/${uploadDataRequest.entityId}/labor/${uploadDataRequest.versionId}`);
    const driverRef = db.doc(`entities/${uploadDataRequest.entityId}/drivers/${uploadDataRequest.versionId}`);

    const existingNLevelAccounts: AcctCheck[] = [];
    const acctSnap = await versionRef.collection('dept').where('class', '==', 'acct').get();
    for (const acct of acctSnap.docs) {
      const acctData = acct.data() as accountDoc;
      existingNLevelAccounts.push({ fullAccount: acctData.full_account, calcType: acctData.calc_type });
    }

    // Drop the header row
    uploadDataRequest.data.shift();

    await db.runTransaction(async (firestoreTxRef) => {
      const versionDoc = await firestoreTxRef.get(versionRef);

      for (const acctDataRow of uploadDataRequest.data) {
        await processAccountRow(
          firestoreTxRef,
          acctDataRow,
          existingNLevelAccounts,
          versionRef,
          laborPosRef,
          driverRef
        );
      }
      // write to version document to ensure that the transaction is atomic until here
      const tsNow = admin.firestore.Timestamp.now();
      firestoreTxRef.update(versionDoc.ref, { last_updated: tsNow });
    });
  } catch (error) {
    throw new Error(`Error occured in [insertDataIntoVersion]: ${error}`);
  }
};

const processAccountRow = async (
  firestoreTx: FirebaseFirestore.Transaction,
  accountDataRow: AccountDataRow,
  existingNLevelAccts: AcctCheck[],
  versionRef: FirebaseFirestore.DocumentReference,
  laborPosRef: FirebaseFirestore.DocumentReference,
  driverRef: FirebaseFirestore.DocumentReference
) => {
  console.log(`Processing Account Row for Upload: ${JSON.stringify(accountDataRow)} for Version ${versionRef.id}, Labor ${laborPosRef.id}, Driver ${driverRef.id} with existing nLevelAccounts: ${JSON.stringify(existingNLevelAccts)}`);
  const acctRef = versionRef.collection('dept').doc(accountDataRow.full_account);
  console.log(`found acct ref: ${JSON.stringify(acctRef)}`);
  const existAcctFiltered = existingNLevelAccts.filter((acct) => acct.fullAccount === accountDataRow.full_account);
  if (existAcctFiltered.length === 1) {
    console.log(`Labor or driver will be overwritten`);
    if (existAcctFiltered[0].calcType === 'driver') {
      console.log(`deleting driver account: ${JSON.stringify(driverRef.id)} - ${accountDataRow.full_account}`);
      firestoreTx.delete(driverRef.collection('dept').doc(accountDataRow.full_account));
    } else if (existAcctFiltered[0].calcType === 'labor') {
      const allPositionsForAccoutSnap = await laborPosRef
        .collection('positions')
        .where('acct', '==', accountDataRow.gl_acct)
        .where('dept', '==', accountDataRow.cost_center)
        .get();
      for (const positionDoc of allPositionsForAccoutSnap.docs) {
        console.log(`deleting position account: ${JSON.stringify(positionDoc.ref)}`);
        firestoreTx.delete(positionDoc.ref);
      }
    }
    console.log(`changing calc type for ${acctRef.id} to "entry"`);
    firestoreTx.update(acctRef, 'calc_type', 'entry');
  }
  console.log(`Uploading values: ${acctRef.id} = ${JSON.stringify(accountDataRow.values)}`);
  firestoreTx.update(acctRef, 'values', accountDataRow.values);
};
