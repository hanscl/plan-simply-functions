import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import * as entityModel from '../entity_model';
import * as laborModel from '../labor/labor_model';
import * as planModel from '../plan_model';
import * as utils from '../utils';
import * as viewModel from '../view_model';
import * as driverModel from '../driver_model';
const cors = require('cors')({ origin: true });

const db = admin.firestore();

interface CalcRequest {
  entityId: string;
  planId: string;
  versionId: string;
}

const divDeptLevelsOnly = ['dept', 'div'] as const;
const allAccountLevels = [...divDeptLevelsOnly, 'pnl'] as const;
const accountTypes = [...allAccountLevels, 'driver'] as const;
type AccountCalculationType = typeof accountTypes[number];
type AccountLevel = typeof allAccountLevels[number];
//type DivDeptLevel = typeof divDeptLevelsOnly[number];
type TypeToLevelDict = {
  [k in AccountCalculationType]: AccountLevel;
};
const mapTypeToLevel: TypeToLevelDict = {
  pnl: 'pnl',
  div: 'div',
  dept: 'dept',
  driver: 'dept',
};

export type PendingAccountByLevel = {
  [k in AccountCalculationType]: AccountWithDependencies[];
};

interface AccountWithDependencies {
  fullAccountId: string;
  dependentAccounts: string[];
}

interface AccountTotal {
  acctId: string;
  values: number[];
  total: number;
}

interface AccountComponents {
  acctId: string;
  deptId: string;
  divId: string;
}

export const versionFullCalc = async (calcRequest: CalcRequest) => {
  try {
    // Calculate LABOR
    const entity = await getEntityDetails(calcRequest.entityId);
    const version = await getVersionDetails(calcRequest);
    await sumUpLaborTotalsFromPositions(calcRequest, entity, version);

    // get all pending ROLLUP accounts & its direct dependents
    const uncalculatedAccounts: PendingAccountByLevel = { dept: [], div: [], pnl: [], driver: [] };
    await getInitialUncalculatedAccounts(calcRequest, uncalculatedAccounts);
    await getDivDeptRollupChildren(calcRequest, uncalculatedAccounts, entity);
    await getPnlRollupChildren(calcRequest, uncalculatedAccounts);
    await getDriverDependentAccounts(calcRequest, uncalculatedAccounts['driver']);
    console.log(`All uncalculated accounts with dependents: ${JSON.stringify(uncalculatedAccounts)}`);
    return;

    //console.log(`Rollup Accts with dependents: ${JSON.stringify(pendingRollups, null, 2)}`);

    // now start processing
    await beginFullCalculationProcess(uncalculatedAccounts);
  } catch (error) {
    console.log(`Error in versionFullCalc: ${error}`);
  }
};

const beginFullCalculationProcess = async (uncalculatedAccounts: PendingAccountByLevel) => {
  const accountTypesToCalculate = [...accountTypes];
  console.log(`Account types still to be calculated${JSON.stringify(accountTypesToCalculate)}`);

  do {
    for (const accountType of accountTypesToCalculate) {
      const remainingAccountsOfType = calculateAccounts(uncalculatedAccounts, accountType);
      if (!remainingAccountsOfType) {
        accountTypesToCalculate.splice(accountTypesToCalculate.indexOf(accountType), 1);
        console.log(
          `Removed [${accountType}] from list of types to be calculated. New List: [${JSON.stringify(
            accountTypesToCalculate
          )}]`
        );
      }
    }
  } while (accountTypesToCalculate.length > 0);
  // console.log(calculateAccounts);
};

const calculateAccounts = async (
  uncalculatedAccounts: PendingAccountByLevel,
  accountType: AccountCalculationType
): Promise<number> => {
  // const rollupNotReadyYet = uncalculatedAccounts[accountType].filter(
  //   (acctWithDeps) => acctWithDeps.dependentAccounts.length > 0
  // );
  // console.log(`These ${level}-level rollups are ready to be calculated: ${JSON.stringify(rollupsReadyForCalculation, null, 2)}`);
  // let loopNumber = 1;

  console.log(`Begin calculation of accounts of type [${accountType}] that are ready for calculation`);

  let foundMoreAcctsForCalc = true;
  do {
    const rollupsReadyForCalculation = uncalculatedAccounts[accountType].filter(
      (acctWithDeps) => acctWithDeps.dependentAccounts.length === 0
    );

    if (rollupsReadyForCalculation.length === 0) {
      foundMoreAcctsForCalc = false;
    }

    for (const acctToBeCalculated of rollupsReadyForCalculation) {
      console.log(`Calculating acct [${acctToBeCalculated.fullAccountId}] of type [${accountType}] ...`);
      removeAccountFromDependencyArrays(uncalculatedAccounts, acctToBeCalculated.fullAccountId);
      // REMOVE account from array
      uncalculatedAccounts[accountType].splice(
        uncalculatedAccounts[accountType].findIndex((el) => el.fullAccountId === acctToBeCalculated.fullAccountId),
        1
      );
    }
  } while (foundMoreAcctsForCalc);

  console.log(`No more accounts of type [${accountType}] can be calculated at this time`);

  const numberOfAccountsNotCalculated = uncalculatedAccounts[accountType].filter(
    (acctWithDeps) => acctWithDeps.dependentAccounts.length > 0
  ).length;

  console.log(`[${numberOfAccountsNotCalculated}] of type [${accountType}] are yet to be calculated`);

  return numberOfAccountsNotCalculated;
};

const removeAccountFromDependencyArrays = (
  uncalculatedAccounts: PendingAccountByLevel,
  calculatedAccountId: string
) => {
  console.log(`Removing acct [${calculatedAccountId}] from all dependencies`);
  let accountsWithDependency: AccountWithDependencies[] = [];
  for (const acctType of accountTypes) {
    accountsWithDependency = accountsWithDependency.concat(
      uncalculatedAccounts[acctType].filter((acctWithDeps) =>
        acctWithDeps.dependentAccounts.includes(calculatedAccountId)
      )
    );
  }

  for (const acctWithDeps of accountsWithDependency) {
    acctWithDeps.dependentAccounts.splice(acctWithDeps.dependentAccounts.indexOf(calculatedAccountId), 1);
  }
};

const getInitialUncalculatedAccounts = async (
  calcRequest: CalcRequest,
  uncalculatedAccounts: PendingAccountByLevel
) => {
  try {
    for (const rollupType of accountTypes) {
      let query: FirebaseFirestore.CollectionReference | FirebaseFirestore.Query;
      query = db.collection(
        `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}/${mapTypeToLevel[rollupType]}`
      );
      if (rollupType === 'dept') {
        query = query.where('class', '==', 'rollup');
      } else if (rollupType === 'driver') {
        query = query.where('calc_type', '==', 'driver');
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

        if (account.class === 'acct' && account.calc_type !== 'driver') {
          continue;
        }

        rollupAccountWithDependents.dependentAccounts.push(accountDocument.id);
      }
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

const sumUpLaborTotalsFromPositions = async (
  calcRequest: CalcRequest,
  entity: entityModel.entityDoc,
  version: planModel.versionDoc
) => {
  try {
    // loop through all positions, add wages (and bonus/socialSec for v2) and set account to laborCalc
    const positionCollectionSnapshot = await db
      .collection(`entities/${calcRequest.entityId}/labor/${calcRequest.versionId}/positions`)
      .get();
    const laborAccountTotals: AccountTotal[] = [];
    for (const positionDocument of positionCollectionSnapshot.docs) {
      const position = positionDocument.data() as laborModel.PositionDoc;
      const acctDivDept = { deptId: position.dept, divId: position.div };
      addAccountValue({ ...acctDivDept, acctId: position.acct }, laborAccountTotals, position.wages.values, entity);

      // OPTIONAL FOR LABOR MODEL V2
      if (version.labor_version && version.labor_version > 1) {
        const acctSocialCmpnts = { ...acctDivDept, acctId: entity.labor_settings.default_accts.socialsec };
        addAccountValue(acctSocialCmpnts, laborAccountTotals, position.socialsec.values, entity);

        const acctBonusCmpnts = { ...acctDivDept, acctId: entity.labor_settings.default_accts.bonus };
        if (position.bonus_option !== 'None') {
          addAccountValue(acctBonusCmpnts, laborAccountTotals, position.bonus.values, entity);
        }
      }
    }

    await updateLaborAccountsInFirestore(calcRequest, laborAccountTotals);
  } catch (error) {
    console.log(`Error occured in [sumUpLaborTotalsFromPositions]: ${error}`);
  }
};

const updateLaborAccountsInFirestore = async (calcRequest: CalcRequest, laborAccountTotals: AccountTotal[]) => {
  try {
    const firestoreBatch = db.batch();
    let batchCounter = 0;
    // firstly, calculate Totals
    laborAccountTotals.map((account) => {
      account.total = account.values.reduce((a, b) => a + b, 0);
    });
    for (const laborAccount of laborAccountTotals) {
      firestoreBatch.update(
        db.doc(
          `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}/dept/${laborAccount.acctId}`
        ),
        { total: laborAccount.total, values: laborAccount.values, calc_type: 'labor' }
      );
      batchCounter++;
    }

    if (batchCounter > 0) {
      // TODO: COMMENT IN FIRESTORE BATCH COMMIT
      // firestoreBatch.commit();
    }
  } catch (error) {
    console.log(`Error occured in [updateLaborAccountsInFirestore]: ${error}`);
  }
};

const addAccountValue = (
  acctCmpnts: AccountComponents,
  accountList: AccountTotal[],
  valuesToAdd: number[],
  entity: entityModel.entityDoc
) => {
  const fullAccountString = utils.buildFullAccountString([entity.full_account], {
    dept: acctCmpnts.deptId,
    div: acctCmpnts.divId,
    acct: acctCmpnts.acctId,
  });
  // see if account is already in array and add values if found; otherwise add new
  const filteredAccounts = accountList.filter((acct) => acct.acctId === fullAccountString);
  if (filteredAccounts.length > 0) {
    filteredAccounts[0].values = utils.addValuesByMonth(filteredAccounts[0].values, valuesToAdd);
  } else {
    accountList.push({ acctId: fullAccountString, values: valuesToAdd, total: 0 });
  }
};

const getEntityDetails = async (entityId: string): Promise<entityModel.entityDoc> => {
  const entityDocument = await db.doc(`entities/${entityId}`).get();
  if (!entityDocument.exists) {
    throw new Error(`Entity Doc not found at getEntityDetails => This should never happen`);
  }
  return entityDocument.data() as entityModel.entityDoc;
};

const getVersionDetails = async (calcRequest: CalcRequest): Promise<planModel.versionDoc> => {
  const versionDocument = await db
    .doc(`entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`)
    .get();
  if (!versionDocument.exists) {
    throw new Error(`Version Doc not found at getVersionDetails => This should never happen`);
  }
  return versionDocument.data() as planModel.versionDoc;
};

export const testRollupHierarchy = functions.https.onCall(async (data, context) => {
  try {
    console.log(`Processing request with values: ${JSON.stringify(data)}`);
    await versionFullCalc(data);
  } catch (error) {
    console.log(`Error occured`);
  }
});

export const testRollupHierarchyRequest = functions.https.onRequest(async (request, response) => {
  cors(request, response, async () => {
    try {
      console.log(`Processing request with values: ${JSON.stringify(request.body)}`);
      await versionFullCalc(request.body);
    } catch (error) {
      console.log(`Error occured`);
    }
  });
});
