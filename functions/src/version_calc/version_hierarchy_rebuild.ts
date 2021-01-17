import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';

import * as entityModel from '../entity_model';
// import * as planModel from '../plan_model';
import * as utils from '../utils';
// import * as viewModel from '../view_model';
// import * as driverModel from '../driver_model';

// import { getEntityDetails, getVersionDetails } from './version_calc_helpers';

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
    // const entity = await getEntityDetails(db, calcRequest.entityId);
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
        processRollupLevel(rollupData, divDict, deptDict, acctDict, rollupSummary.items, versionDocumentReference);
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
  versionDocRef: FirebaseFirestore.DocumentReference
) => {
  console.log(`processing rollup definition: ${JSON.stringify(rollupDefinition)}`);
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
