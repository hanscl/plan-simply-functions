import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

import * as entityModel from '../entity_model';
import * as planModel from '../plan_model';
import * as utils from '../utils';
import * as viewModel from '../view_model';
import * as driverModel from '../driver_model';

import { calculateAccount } from './calculate_account';
import { sumUpLaborTotalsFromPositions } from './calculate_labor';
import { getEntityDetails, getVersionDetails} from './version_calc_helpers';

import {
  CalcRequest,
  AccountCalculationType,
  accountTypes,
  mapTypeToLevel,
  divDeptLevelsOnly,
} from './version_calc_model';
const cors = require('cors')({ origin: true });

const db = admin.firestore();

export type PendingAccountByLevel = {
  [k in AccountCalculationType]: AccountWithDependencies[];
};

interface AccountWithDependencies {
  fullAccountId: string;
  dependentAccounts: string[];
}

export const versionFullCalc = async (calcRequest: CalcRequest) => {
  try {
    const versionDocumentReference = db.doc(
      `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`
    );
    // set calculated to false to protect the version from incremental calc
    await versionDocumentReference.update({ calculated: false });

    // get additional information from the database for the recalc process
    const entity = await getEntityDetails(db, calcRequest.entityId);
    const version = await getVersionDetails(db, calcRequest);

    // Calculate LABOR only for regular entities (not rollups)
    if (entity.type === 'entity') {
      await sumUpLaborTotalsFromPositions(calcRequest, entity, version);
    }

    await determineCalculationDependencies(calcRequest, entity);

    // now start processing
    await beginFullCalculationProcess(calcRequest, entity);

    // update timestamp and set calculated to true, which will trigger view regeneration
    await versionDocumentReference.update({ calculated: true, last_updated: admin.firestore.Timestamp.now() });
  } catch (error) {
    console.log(`Error in versionFullCalc: ${error}`);
  }
};

const determineCalculationDependencies = async (calcRequest: CalcRequest, entity: entityModel.entityDoc) => {
  // get all pending ROLLUP accounts & its direct dependents
  const uncalculatedAccounts: PendingAccountByLevel = { dept: [], div: [], group: [], pnl: [], driver: [] };
  await getInitialUncalculatedAccounts(calcRequest, uncalculatedAccounts, entity);
  await getDivDeptRollupChildren(calcRequest, uncalculatedAccounts, entity);
  await getPnlRollupChildren(calcRequest, uncalculatedAccounts);
  await getGroupChildren(calcRequest, uncalculatedAccounts);
  await getDriverDependentAccounts(calcRequest, uncalculatedAccounts['driver']);
  // console.log(`ALL ACCOUNTS: ${JSON.stringify(uncalculatedAccounts)}`);
  await saveDependenciesToFirestore(uncalculatedAccounts, calcRequest);
};

const saveDependenciesToFirestore = async (uncalculatedAccounts: PendingAccountByLevel, calcRequest: CalcRequest) => {
  let firestoreBatch = db.batch();
  let dbOpsCounter = 0;

  for (const accountType of accountTypes) {
    const versionCalcDocRef = db.doc(`entities/${calcRequest.entityId}/calcs/${calcRequest.versionId}`);
    await versionCalcDocRef.set({});
    for (const acctWithDependencies of uncalculatedAccounts[accountType]) {
      firestoreBatch.set(versionCalcDocRef.collection(accountType).doc(acctWithDependencies.fullAccountId), {
        precedents: acctWithDependencies.dependentAccounts,
      });
      dbOpsCounter++;
    }
    if (dbOpsCounter > 0) {
      await firestoreBatch.commit();
      firestoreBatch = db.batch();
      dbOpsCounter = 0;
    }
  }
};

const beginFullCalculationProcess = async (calcRequest: CalcRequest, entity: entityModel.entityDoc) => {
  const accountTypesToCalculate = [...accountTypes];
  const versionCalcDocRef = db.doc(`entities/${calcRequest.entityId}/calcs/${calcRequest.versionId}`);

  console.log(`Account types still to be calculated${JSON.stringify(accountTypesToCalculate)}`);

  do {
    for (const accountType of accountTypesToCalculate) {
      const acctTypeCollSnap = await versionCalcDocRef.collection(accountType).get();
      if (acctTypeCollSnap.empty) {
        accountTypesToCalculate.splice(accountTypesToCalculate.indexOf(accountType), 1);
        console.log(
          `Removed [${accountType}] from list of types to be calculated. New List: [${JSON.stringify(
            accountTypesToCalculate
          )}]`
        );
      } else {
        await calculateAccounts(accountType, calcRequest, entity);
      }
    }
  } while (accountTypesToCalculate.length > 0);

  await versionCalcDocRef.delete();
};

const calculateAccounts = async (
  accountType: AccountCalculationType,
  calcRequest: CalcRequest,
  entity: entityModel.entityDoc
) => {
  console.log(`Begin calculation of accounts of type [${accountType}] that are ready for calculation`);
  const acctTypeCollRef = db.collection(
    `entities/${calcRequest.entityId}/calcs/${calcRequest.versionId}/${accountType}`
  );

  let acctsReadyForCalc: string[] = [];
  do {
    acctsReadyForCalc = [];
    const allAcctsOfTypeCollSnap = await acctTypeCollRef.get();

    for (const acctDocument of allAcctsOfTypeCollSnap.docs) {
      if (acctDocument.data().precedents.length === 0) {
        acctsReadyForCalc.push(acctDocument.id);
      }
    }

    console.log(`Found these accounts of type [${accountType}] ready for calc: ${acctsReadyForCalc}`);

    let firestoreBatch = db.batch();
    let dbOpsCounter = 0;
    for (const acctToBeCalculated of acctsReadyForCalc) {
      // console.log(`Calculating acct [${acctToBeCalculated}] of type [${accountType}] ...`);
      await calculateAccount(calcRequest, acctToBeCalculated, accountType, entity);

      await removeAccountFromDependencyArrays(acctToBeCalculated, calcRequest);

      firestoreBatch.delete(acctTypeCollRef.doc(acctToBeCalculated));
      dbOpsCounter++;
      if (dbOpsCounter > 450) {
        await firestoreBatch.commit();
        firestoreBatch = db.batch();
        dbOpsCounter = 0;
      }
    }
    // FINAL BATCH COMMIT
    if (dbOpsCounter > 0) {
      await firestoreBatch.commit();
    }
  } while (acctsReadyForCalc.length > 0);

  console.log(`No more accounts of type [${accountType}] can be calculated at this time`);
};

const removeAccountFromDependencyArrays = async (calculatedAccountId: string, calcRequest: CalcRequest) => {
  // console.log(`Removing acct [${calculatedAccountId}] from all dependencies`);

  const versionCalcDocRef = db.doc(`entities/${calcRequest.entityId}/calcs/${calcRequest.versionId}`);

  let firestoreBatch = db.batch();
  let dbOpsCounter = 0;
  for (const acctType of accountTypes) {
    const query = versionCalcDocRef.collection(acctType).where('precedents', 'array-contains', calculatedAccountId);
    const dependentAcctCollSnap = await query.get();
    for (const depAcctDoc of dependentAcctCollSnap.docs) {
      firestoreBatch.update(depAcctDoc.ref, 'precedents', admin.firestore.FieldValue.arrayRemove(calculatedAccountId));
      dbOpsCounter++;
    }
    if (dbOpsCounter > 450) {
      await firestoreBatch.commit();
      firestoreBatch = db.batch();
      dbOpsCounter = 0;
    }
  }
  if (dbOpsCounter > 0) {
    await firestoreBatch.commit();
  }
};

const getInitialUncalculatedAccounts = async (
  calcRequest: CalcRequest,
  uncalculatedAccounts: PendingAccountByLevel,
  entity: entityModel.entityDoc
) => {
  try {
    for (const rollupType of accountTypes) {
      if (rollupType === 'driver' && entity.type === 'rollup') {
        continue;
      }

      let query: FirebaseFirestore.CollectionReference | FirebaseFirestore.Query;
      query = db.collection(
        `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}/${mapTypeToLevel[rollupType]}`
      );

      if (rollupType === 'dept') {
        query = query.where('class', '==', 'rollup').where('group', '==', false);
      } else if (rollupType === 'driver') {
        query = query.where('calc_type', '==', 'driver');
      } else if (rollupType === 'group') {
        query = query.where('group', '==', true);
      }

      const rollupCollectionSnapshot = await query.get();
      for (const rollupDocument of rollupCollectionSnapshot.docs) {
        uncalculatedAccounts[rollupType].push({ fullAccountId: rollupDocument.id, dependentAccounts: [] });
      }
    }
  } catch (error) {
    throw new Error(`Error occured in [getUncalculatedRollups]: ${error}`);
  }
};

const getDivDeptRollupChildren = async (
  calcRequest: CalcRequest,
  uncalculatedRollups: PendingAccountByLevel,
  entity: entityModel.entityDoc
) => {
  const versionDocumentReference = db.doc(
    `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`
  );
  for (const rollupLevel of divDeptLevelsOnly) {
    for (const rollupAccountWithDependents of uncalculatedRollups[rollupLevel]) {
      const acctCmpnts = utils.extractComponentsFromFullAccountString(rollupAccountWithDependents.fullAccountId, [
        entity.full_account,
        entity.div_account,
      ]);

      let query = versionDocumentReference.collection('dept').where('div', '==', acctCmpnts.div);

      if (rollupLevel === 'dept') {
        query = query.where('dept', '==', acctCmpnts.dept).where('parent_rollup.acct', '==', acctCmpnts.acct);
      } else {
        query = query.where('acct', '==', acctCmpnts.acct);
      }

      const acctCollectionSnapshot = await query.get();
      for (const accountDocument of acctCollectionSnapshot.docs) {
        const account = accountDocument.data() as planModel.accountDoc;

        if (account.class === 'acct') {
          if (entity.type === 'rollup') {
            continue;
          } else if (entity.type === 'entity' && account.calc_type !== 'driver') {
            continue;
          }
        }

        rollupAccountWithDependents.dependentAccounts.push(accountDocument.id);
      }
    }
  }
};

const getGroupChildren = async (calcRequest: CalcRequest, uncalculatedRollups: PendingAccountByLevel) => {
  const versionDocumentReference = db.doc(
    `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`
  );

  for (const rollupAccountWithDependents of uncalculatedRollups['group']) {
    const groupDocumentSnapshot = await versionDocumentReference
      .collection('dept')
      .doc(rollupAccountWithDependents.fullAccountId)
      .get();

    if (!groupDocumentSnapshot.exists) {
      throw new Error(`Group document not found in collection: ${rollupAccountWithDependents.fullAccountId}`);
    }

    const groupAccount = groupDocumentSnapshot.data() as planModel.accountDoc;
    if (groupAccount.group_children) {
      rollupAccountWithDependents.dependentAccounts = rollupAccountWithDependents.dependentAccounts.concat(
        groupAccount.group_children
      );
    }
  }
};

const getPnlRollupChildren = async (calcRequest: CalcRequest, uncalculatedRollups: PendingAccountByLevel) => {
  const versionDocumentReference = db.doc(
    `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`
  );

  for (const rollupAccountWithDependents of uncalculatedRollups['pnl']) {
    const pnlDocumentSnapshot = await versionDocumentReference
      .collection('pnl')
      .doc(rollupAccountWithDependents.fullAccountId)
      .get();

    if (!pnlDocumentSnapshot.exists) {
      throw new Error(`pnlDocument not found in collection: ${rollupAccountWithDependents.fullAccountId}`);
    }

    const pnlAccount = pnlDocumentSnapshot.data() as viewModel.pnlAggregateDoc;

    rollupAccountWithDependents.dependentAccounts = rollupAccountWithDependents.dependentAccounts.concat(
      pnlAccount.child_accts
    );
  }
};

const getDriverDependentAccounts = async (calcRequest: CalcRequest, uncalculatedDrivers: AccountWithDependencies[]) => {
  const versionDocumentReference = db.doc(
    `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`
  );

  const driverDocumentReference = db.doc(`entities/${calcRequest.entityId}/drivers/${calcRequest.versionId}`);

  for (const driverAccountWithDependents of uncalculatedDrivers) {
    const driverAccountSnapshot = await driverDocumentReference
      .collection('dept')
      .doc(driverAccountWithDependents.fullAccountId)
      .get();

    if (!driverAccountSnapshot.exists) {
      // TODO: update account calc_type to 'entry' and remove account from driver collection
      console.log(`ERROR: Driver document not found in collection: ${driverAccountWithDependents.fullAccountId}`);
    }

    const driverAccount = driverAccountSnapshot.data() as driverModel.acctDriverDef;
    for (const driverEntry of driverAccount.drivers) {
      if (driverEntry.type !== 'acct') {
        continue;
      }

      const driverAccountEntry = driverEntry.entry as driverModel.driverAcct;

      if (driverAccountEntry.level === 'div' || driverAccountEntry.level === 'pnl') {
        driverAccountWithDependents.dependentAccounts.push(driverAccountEntry.id);
      } else {
        const dependentAccountSnapshot = await versionDocumentReference
          .collection('dept')
          .doc(driverAccountEntry.id)
          .get();

        if (!dependentAccountSnapshot.exists) {
          throw new Error(`Could not find account in [getDriverDependentAccounts]`);
        }

        const dependentAccount = dependentAccountSnapshot.data() as planModel.accountDoc;

        if (dependentAccount.class !== 'acct' || dependentAccount.calc_type === 'driver') {
          driverAccountWithDependents.dependentAccounts.push(driverAccountEntry.id);
        }
      }
    }
  }
};

export const testRollupHierarchy = functions.runWith({ timeoutSeconds: 540 }).https.onCall(async (data, context) => {
  try {
    console.log(`Processing request with values: ${JSON.stringify(data)}`);
    console.log(`Context: ${JSON.stringify(context.auth)}`);
    await versionFullCalc(data);
  } catch (error) {
    console.log(`Error occured`);
  }
});

export const testRollupHierarchyRequest = functions
  .runWith({ timeoutSeconds: 540 })
  .https.onRequest(async (request, response) => {
    cors(request, response, async () => {
      try {
        console.log(`Processing request with values: ${JSON.stringify(request.body)}`);
        await versionFullCalc(request.body);
        response.status(200).send();
      } catch (error) {
        console.log(`Error occured`);
      }
    });
  });
