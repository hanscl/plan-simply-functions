import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

import * as entityModel from '../entity_model';
import * as planModel from '../plan_model';
import * as utils from '../utils';
// import * as viewModel from '../view_model';
// import * as driverModel from '../driver_model';

import { getEntityDetails } from './version_calc_helpers';

import { CalcRequest } from './version_calc_model';
const db = admin.firestore();

const rebuildVersionHierarchy = async (calcRequest: CalcRequest) => {
  try {
    const versionDocumentReference = db.doc(
      `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`
    );
    // set calculated to false to protect the version from incremental calc
    await versionDocumentReference.update({ calculated: false });

    // get additional information from the database for the recalc process
    const entity = await getEntityDetails(db, calcRequest.entityId);
    // const version = await getVersionDetails(db, calcRequest);

    // delete all rollups => pnl coll / div coll /
    await utils.deleteCollection(versionDocumentReference.collection('pnl'), 300);
    await utils.deleteCollection(versionDocumentReference.collection('div'), 300);
    await utils.deleteDocumentsByQuery(versionDocumentReference.collection('dept').where('class', '==', 'rollup'), 300);

    const divDict = (await getEntityStructureData(calcRequest.entityId, 'div')) as entityModel.divDict;
    const deptDict = (await getEntityStructureData(calcRequest.entityId, 'dept')) as entityModel.deptDict;
    const acctDict = (await getEntityStructureData(calcRequest.entityId, 'acct')) as entityModel.acctDict;

    const rollupSummary = (await getEntityStructureData(
      calcRequest.entityId,
      'rollup'
    )) as entityModel.RollupSummaryDoc;

    console.log(JSON.stringify(divDict));
    console.log(JSON.stringify(deptDict));
    console.log(JSON.stringify(acctDict));
    console.log(JSON.stringify(rollupSummary));

    for (let levelIndex = rollupSummary.max_level; levelIndex >= 0; levelIndex--) {
      const rollupDocSnapshot = await db
        .collection(`entities/${calcRequest.entityId}/entity_structure/rollup/rollups`)
        .where('level', '==', levelIndex)
        .get();

      for (const rollupDocument of rollupDocSnapshot.docs) {
        const rollupData = rollupDocument.data() as entityModel.EntityRollupDocument;
        await processRollupLevel(rollupData, divDict, deptDict, acctDict, rollupSummary.items, versionDocumentReference, [
          entity.full_account,
          entity.div_account,
        ]);
      }
    }

    // update timestamp and set calculated to true, which will trigger view regeneration
    await versionDocumentReference.update({ last_updated: admin.firestore.Timestamp.now() });
  } catch (error) {
    console.log(`Error in [rebuildVersionHierarchy]: ${error}`);
  }
};

const processRollupLevel = async (
  rollupDefinition: entityModel.EntityRollupDocument,
  divDict: entityModel.divDict,
  deptDict: entityModel.deptDict,
  acctDict: entityModel.acctDict,
  rollupNames: entityModel.rollupNameMap[],
  versionDocRef: FirebaseFirestore.DocumentReference,
  entityFullAccountStrings: string[]
) => {
  console.log(`processing rollup definition: ${JSON.stringify(rollupDefinition)}`);

  const acctList: planModel.accountDoc[] = [];

  if (rollupDefinition.child_rollups) {
    const acctDocsSnap = await versionDocRef
      .collection('dept')
      .where('acct', 'in', Object.keys(rollupDefinition.child_rollups))
      .get();

    for (const acctDoc of acctDocsSnap.docs) {
      const childAccount = acctDoc.data() as planModel.accountDoc;

      childAccount.parent_rollup = {
        acct: rollupDefinition.rollup,
        operation: rollupDefinition.child_rollups[childAccount.acct],
      };

      acctList.push(childAccount);
    }
  } else {
    const acctDocsSnap = await versionDocRef
      .collection('dept')
      .where('acct_type', 'in', rollupDefinition.acct_types)
      .get();

    for (const acctDoc of acctDocsSnap.docs) {
      const childAccount = acctDoc.data() as planModel.accountDoc;

      let newAcctTotal = 0;
      if (childAccount.acct_type !== 'STATS') {
        newAcctTotal = childAccount.values.reduce((a, b) => a + b, 0);
      }
      childAccount.parent_rollup = { acct: rollupDefinition.rollup, operation: 1 };
      childAccount.total = newAcctTotal;

      acctList.push(childAccount);
    }
  }
  if (acctList.length > 0) {
    await updateAllAccounts(
      acctList,
      rollupDefinition,
      divDict,
      deptDict,
      acctDict,
      rollupNames,
      versionDocRef,
      entityFullAccountStrings
    );
  }
};

const updateAllAccounts = async (
  acctList: planModel.accountDoc[],
  rollupDefinition: entityModel.EntityRollupDocument,
  divDict: entityModel.divDict,
  deptDict: entityModel.deptDict,
  acctDict: entityModel.acctDict,
  rollupNames: entityModel.rollupNameMap[],
  versionDocRef: FirebaseFirestore.DocumentReference,
  entityFullAccountStrings: string[]
) => {
  for (const divId of Object.keys(divDict)) {
    let divAccountsFound = false;
    const divAccountsUpdated: string[] = [];

    for (const deptId of divDict[divId].depts) {
      let deptAccountsFound = false;
      const acctsForDept = acctList.filter((acct) => acct.dept === deptId);

      for (const account of acctsForDept) {
        divAccountsFound = true;
        deptAccountsFound = true;
        let acctName = '';

        if (account.class === 'acct') {
          acctName = acctDict[account.acct].name;
        } else {
          acctName = rollupNames.filter((nameMap) => nameMap.code === account.acct)[0].name;
        }

        await versionDocRef
          .collection('dept')
          .doc(account.full_account)
          .update({
            parent_rollup: account.parent_rollup,
            acct_name: acctName,
            total: account.total,
            divdept_name: deptDict[account.dept ? account.dept : ''].name,
            is_group_child: false,
          });

        if (account.class === 'rollup' && !divAccountsUpdated.includes(account.acct)) {
          const divRollupQuerySnap = await versionDocRef
            .collection('div')
            .where('acct', '==', account.acct)
            .where('div', '==', divId)
            .get();
          if (!divRollupQuerySnap.empty) {
            await divRollupQuerySnap.docs[0].ref.update({ parent_rollup: account.parent_rollup });
            divAccountsUpdated.push(account.acct);
          }
        }
      }
      if (deptAccountsFound) {
        await updateRollupAccountsInFirestore(
          divDict,
          deptDict,
          rollupNames,
          versionDocRef,
          entityFullAccountStrings,
          rollupDefinition.rollup,
          divId,
          deptId
        );
      }
    } // end dept loop
    if (divAccountsFound) {
      await updateRollupAccountsInFirestore(
        divDict,
        deptDict,
        rollupNames,
        versionDocRef,
        entityFullAccountStrings,
        rollupDefinition.rollup,
        divId
      );
    }
  } // end div loop
};

const updateRollupAccountsInFirestore = async (
  divDict: entityModel.divDict,
  deptDict: entityModel.deptDict,
  rollupNames: entityModel.rollupNameMap[],
  versionDocRef: FirebaseFirestore.DocumentReference,
  entityFullAccountStrings: string[],
  acctId: string,
  divId: string,
  deptId?: string
) => {
  const fullAccount = utils.buildFullAccountString(entityFullAccountStrings, {
    acct: acctId,
    div: divId,
    dept: deptId,
  });
  const acctUpdates = {
    acct: acctId,
    acct_name: rollupNames.filter((rollup) => rollup.code === acctId)[0].name,
    class: 'rollup',
    group: false,
    is_group_child: false,
    div: divId,
    total: 0,
    values: utils.getValuesArray(),
    full_account: fullAccount,
  };

  let finalAcctUpdates = {};
  if (deptId) {
    finalAcctUpdates = { ...acctUpdates, divdept_name: deptDict[deptId].name, dept: deptId };
  } else {
    finalAcctUpdates = { ...acctUpdates, divdept_name: divDict[divId].name };
  }

  await versionDocRef
    .collection(deptId ? 'dept' : 'div')
    .doc(fullAccount)
    .set(finalAcctUpdates);
};

const getEntityStructureData = async (
  entityId: string,
  dictId: 'div' | 'dept' | 'acct' | 'rollup'
): Promise<FirebaseFirestore.DocumentData | undefined> => {
  const entityStructureDocSnap = await db.doc(`entities/${entityId}/entity_structure/${dictId}`).get();
  if (!entityStructureDocSnap.exists) {
    throw new Error(`could not find ${dictId} doc for ${entityId}`);
  }
  return entityStructureDocSnap.data();
};

export const testHierarchyRebuild = functions.runWith({ timeoutSeconds: 540 }).https.onCall(async (data, context) => {
  try {
    console.log(`Processing hierarchy rebuild with values: ${JSON.stringify(data)}`);
    await rebuildVersionHierarchy(data);
  } catch (error) {
    console.log(`Error occured`);
  }
});
