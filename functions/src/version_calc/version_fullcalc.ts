import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import * as entityModel from '../entity_model';
import * as laborModel from '../labor/labor_model';
import * as planModel from '../plan_model';
import * as utils from '../utils';

const db = admin.firestore();

interface CalcRequest {
  entityId: string;
  planId: string;
  versionId: string;
}

export type PendingAccountByLevel = {
  [k: string]: string[];
};

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
    const entity = await getEntityDetails(calcRequest.entityId);
    const version = await getVersionDetails(calcRequest);
    await sumUpLaborTotalsFromPositions(calcRequest, entity, version);
    // get all pending account
    const pendingRollups = await getUncalculatedRollups(calcRequest);
    const pendingDriverAccounts = await getUncalculatedDriverAccounts(calcRequest);
    console.log(pendingRollups,pendingDriverAccounts);
  } catch (error) {
    console.log(`Error in versionFullCalc: ${error}`);
  }
};

const getUncalculatedRollups = async (calcRequest: CalcRequest): Promise<PendingAccountByLevel> => {
  try {
    const pendingRollups: PendingAccountByLevel = { dept: [], div: [], pnl: [] };
    for (const rollupLevel of Object.keys(pendingRollups)) {
      let query: FirebaseFirestore.CollectionReference | FirebaseFirestore.Query;
      query = db.collection(
        `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}/${rollupLevel}`
      );
      if (rollupLevel === 'dept') {
        query = query.where('class', '==', 'rollup');
      }
      const rollupCollectionSnapshot = await query.get();
      for (const rollupDocument of rollupCollectionSnapshot.docs) {
        pendingRollups[rollupLevel].push(rollupDocument.id);
      }
    }
    return pendingRollups;
  } catch (error) {
    throw new Error(`Error occured in [getUncalculatedRollups]: ${error}`);
  }
};

const getUncalculatedDriverAccounts = async (calcRequest: CalcRequest): Promise<PendingAccountByLevel> => {
  try {
    // get all pnl accounts
    const pendingDriverAccounts: PendingAccountByLevel = { dept: [] };

    const query = db
      .collection(
        `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}/dept`
      )
      .where('calc_type', '==', 'driver');

    const driverAccountCollectionSnapshot = await query.get();
    for (const driverAccountDocument of driverAccountCollectionSnapshot.docs) {
      pendingDriverAccounts['dept'].push(driverAccountDocument.id);
    }
    return pendingDriverAccounts;
  } catch (error) {
    throw new Error(`Error occured in [getUncalculatedDriverAccounts]: ${error}`);
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
    console.log(`LABOR ACCOUNTS AFTER MAP-REDUCE: ${JSON.stringify(laborAccountTotals)}`);
    for (const laborAccount of laborAccountTotals) {
      console.log(`updating account ${JSON.stringify(laborAccount)} in firestore`);
      firestoreBatch.update(
        db.doc(
          `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}/dept/${laborAccount.acctId}`
        ),
        { total: laborAccount.total, values: laborAccount.values, calc_type: 'labor' }
      );
      batchCounter++;
    }

    if (batchCounter > 0) {
      // TODO: COMMENT IN FIRESTORE COMMIT
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
