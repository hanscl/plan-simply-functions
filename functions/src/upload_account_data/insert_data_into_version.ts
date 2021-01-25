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
  const acctRef = versionRef.collection('dept').doc(accountDataRow.full_account);
  const existAcctFiltered = existingNLevelAccts.filter((acct) => acct.fullAccount === accountDataRow.full_account);
  if (existAcctFiltered.length === 1) {
    if (existAcctFiltered[0].calcType === 'driver') {
      firestoreTx.delete(driverRef.collection('dept').doc(accountDataRow.full_account));
    } else if (existAcctFiltered[0].calcType === 'labor') {
      const allPositionsForAccoutSnap = await laborPosRef
        .collection('positions')
        .where('acct', '==', accountDataRow.gl_acct)
        .where('dept', '==', accountDataRow.cost_center)
        .get();
      for (const positionDoc of allPositionsForAccoutSnap.docs) {
        firestoreTx.delete(positionDoc.ref);
      }
    }
    firestoreTx.update(acctRef, 'calc_type', 'entry');
  }
  firestoreTx.update(acctRef, 'values', accountDataRow.values);
};
