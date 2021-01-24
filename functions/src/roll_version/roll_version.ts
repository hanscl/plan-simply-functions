import * as admin from 'firebase-admin';
import { versionDoc, planVersionCalendar } from '../plan_model';
import { deleteCollection, initializeVersionLockObject } from '../utils';
import { completeRebuildAndRecalcVersion } from '../version_complete_rebuild';
import { RollVersionRequest } from './roll_version_model';

const db = admin.firestore();

export const beginRollVersion = async (rollVersionRequest: RollVersionRequest, recalcNewVersion: boolean) => {
  try {
    let query = db.collection(`entities`).where('type', '==', 'entity');
    if (rollVersionRequest.entityId) {
      query = query.where(admin.firestore.FieldPath.documentId(), '==', rollVersionRequest.entityId);
    }
    const entityCollectionSnapshot = await query.get();

    for (const entityDoc of entityCollectionSnapshot.docs) {
      const { targetPlanId, targetVersionId } = await findEntityVersionSourceDocument(
        entityDoc.ref,
        rollVersionRequest
      );
      if (recalcNewVersion) {
        await completeRebuildAndRecalcVersion({
          entityId: entityDoc.id,
          planId: targetPlanId,
          versionId: targetVersionId,
        });
      }
    }

    console.log('done');
  } catch (error) {
    throw new Error(`Error occured in [beginRollVersion]: ${error}`);
  }
};

const findEntityVersionSourceDocument = async (
  entityRef: FirebaseFirestore.DocumentReference,
  rollVersionRequest: RollVersionRequest
) => {
  const { planName: sourcePlanName, versionName: sourceVersionName } = rollVersionRequest.sourcePlanVersion;
  const planSnapshot = await entityRef.collection('plans').where('name', '==', sourcePlanName).get();

  if (planSnapshot.empty) {
    throw new Error(
      `Error occured in [findEntityVersionSourceDocument]: Could not find Plan ${sourcePlanName} in Entity ${entityRef.id}`
    );
  }

  const sourcePlanRef = planSnapshot.docs[0].ref;
  const versionSnapshot = await sourcePlanRef.collection('versions').where('name', '==', sourceVersionName).get();

  if (versionSnapshot.empty) {
    throw new Error(
      `Error occured in [findEntityVersionSourceDocument]: Could not find Version ${sourceVersionName} for Plan ${sourcePlanName} in Entity ${entityRef.id}`
    );
  }

  return await rollVersionForEntity(entityRef, sourcePlanRef, versionSnapshot.docs[0].ref, rollVersionRequest);
};

const rollVersionForEntity = async (
  entityRef: FirebaseFirestore.DocumentReference,
  sourcePlanRef: FirebaseFirestore.DocumentReference,
  sourceVersionRef: FirebaseFirestore.DocumentReference,
  rollVersionRequest: RollVersionRequest
) => {
  const { planName: targetPlanName, versionName: targetVersionName } = rollVersionRequest.targetPlanVersion;

  const targetPlanRef = await getTargetPlanDocRef(entityRef, targetPlanName);

  let clearAccountCollections = true;
  let targetVersionRef = await getTargetVersionRef(targetPlanRef, targetVersionName);
  if (targetVersionRef === null) {
    targetVersionRef = await createNewTargetVersion(targetPlanRef, targetVersionName);
    clearAccountCollections = false;
  }

  await prepareVersionDocumentForNewData(sourcePlanRef, sourceVersionRef, targetVersionRef, clearAccountCollections);

  await db.runTransaction(async (firestoreTxRef) => {
    if (targetVersionRef) {
      await copyVersionAccounts(
        sourceVersionRef,
        targetVersionRef,
        rollVersionRequest.lockSourceVersion,
        firestoreTxRef
      );
    }
  });

  if (rollVersionRequest.copyDrivers) {
    await copyDriversOrLaborPositions(entityRef, sourceVersionRef.id, targetPlanRef.id, targetVersionRef.id, {
      main: 'drivers',
      sub: 'dept',
    });
  } else {
    await resetAccountCalcFlag(targetVersionRef, 'driver');
  }

  if (rollVersionRequest.copyLaborPositions) {
    await copyDriversOrLaborPositions(entityRef, sourceVersionRef.id, targetPlanRef.id, targetVersionRef.id, {
      main: 'drivers',
      sub: 'dept',
    });
  } else {
    resetAccountCalcFlag(targetVersionRef, 'labor');
  }

  return { targetVersionId: targetVersionRef.id, targetPlanId: targetPlanRef.id };
};

const getTargetPlanDocRef = async (entityRef: FirebaseFirestore.DocumentReference, planName: string) => {
  const targetPlanSnapshot = await entityRef.collection('plans').where('name', '==', planName).get();
  if (targetPlanSnapshot.empty) {
    throw new Error(
      `Error occured in [getTargetPlanDocRef]: Plan ${planName} does not exist in Entity ${entityRef.id}`
    );
  }
  return targetPlanSnapshot.docs[0].ref;
};

const getTargetVersionRef = async (planRef: FirebaseFirestore.DocumentReference, versionName: string) => {
  const versionSnapshot = await planRef.collection('versions').where('name', '==', versionName).get();

  if (versionSnapshot.empty) {
    return null;
  } else {
    return versionSnapshot.docs[0].ref;
  }
};

const createNewTargetVersion = async (planRef: FirebaseFirestore.DocumentReference, versionName: string) => {
  let versionNumber = 0;
  const existingVersionSnapshot = await planRef.collection('versions').orderBy('number', 'desc').limit(1).get();

  if (!existingVersionSnapshot.empty) {
    versionNumber = ++(existingVersionSnapshot.docs[0].data() as versionDoc).number;
  }

  return await planRef
    .collection('versions')
    .add({ number: versionNumber, name: versionName, last_updated: admin.firestore.Timestamp.now() });
};

const prepareVersionDocumentForNewData = async (
  sourcePlanRef: FirebaseFirestore.DocumentReference,
  sourceVersionRef: FirebaseFirestore.DocumentReference,
  targetVersionRef: FirebaseFirestore.DocumentReference,
  clearAccountCollections: boolean
) => {
  if (clearAccountCollections) {
    for (const levelId of ['dept', 'div', 'dept', 'pnl']) {
      await deleteCollection(targetVersionRef.collection(levelId), 400);
    }
  }

  console.log(`VERSION REF`, sourceVersionRef);
  const versionSnap = await sourceVersionRef.get();
  if (!versionSnap.exists) {
    throw new Error(`Version doc not found in [prepareVersionDocumentForNewData]`);
  }

  const versionDoc = versionSnap.data() as versionDoc;
  console.log('VERSION:', JSON.stringify(versionDoc));
  let calendarConfig = versionSnap.data() as planVersionCalendar;
  

  if (!calendarConfig.begin_month || !calendarConfig.begin_year || !calendarConfig.periods || !calendarConfig.total) {
    const planSnap = await sourcePlanRef.get();
    if(!planSnap.exists) {
      throw new Error(`Plan doc not found in [prepareVersionDocumentForNewData]`);
    }
    calendarConfig = planSnap.data() as planVersionCalendar;
  }

  console.log('CALENDAR:', JSON.stringify(calendarConfig));

  const versionFieldUpdates = {
    last_updated: admin.firestore.Timestamp.now(),
    calculated: false,
    ready_for_view: false,
    is_locked: initializeVersionLockObject(false),
    pnl_structure_id: versionDoc.pnl_structure_id,
    labor_version: versionDoc.labor_version ? versionDoc.labor_version : 1,
    begin_month: calendarConfig.begin_month,
    begin_year: calendarConfig.begin_year,
    periods: calendarConfig.periods,
    total: calendarConfig.total,
  };

  await targetVersionRef.set(versionFieldUpdates, { merge: true });
};

const copyVersionAccounts = async (
  sourceVersionRef: FirebaseFirestore.DocumentReference,
  targetVersionRef: FirebaseFirestore.DocumentReference,
  lockSourceVersion: boolean,
  firestoreCopyTx: FirebaseFirestore.Transaction
) => {
  const sourceVersionDoc = await firestoreCopyTx.get(sourceVersionRef);
  const targetVersionDoc = await firestoreCopyTx.get(targetVersionRef);

  const sourceAccountQuerySnap = await sourceVersionRef.collection('dept').where('class', '==', 'acct').get();

  for (const sourceAcctDoc of sourceAccountQuerySnap.docs) {
    firestoreCopyTx.set(targetVersionRef.collection('dept').doc(sourceAcctDoc.id), sourceAcctDoc.data());
  }

  const tsNow = admin.firestore.Timestamp.now();

  firestoreCopyTx.update(targetVersionDoc.ref, { last_updated: tsNow });

  if (lockSourceVersion) {
    firestoreCopyTx.update(sourceVersionDoc.ref, { last_updated: tsNow, is_locked: initializeVersionLockObject(true) });
  } else {
    firestoreCopyTx.update(sourceVersionDoc.ref, { last_updated: tsNow });
  }
};

const copyDriversOrLaborPositions = async (
  entityRef: FirebaseFirestore.DocumentReference,
  sourceVersionDocId: string,
  targetPlanDocId: string,
  targetVersionDocId: string,
  collectionIDs: { main: string; sub: string }
) => {
  let firestoreCopyBatch = db.batch();
  let batchCounter = 0;

  const targetLaborOrDriverDocRef = entityRef.collection(collectionIDs.main).doc(targetVersionDocId);

  firestoreCopyBatch.set(targetLaborOrDriverDocRef, { plan_id: targetPlanDocId, version_id: targetVersionDocId });

  const sourceCollSnap = await entityRef
    .collection(collectionIDs.main)
    .doc(sourceVersionDocId)
    .collection(collectionIDs.sub)
    .get();

  for (const sourceDoc of sourceCollSnap.docs) {
    firestoreCopyBatch.set(targetLaborOrDriverDocRef.collection(collectionIDs.sub).doc(sourceDoc.id), sourceDoc.data());
    batchCounter++;

    if (batchCounter > 450) {
      await firestoreCopyBatch.commit();
      firestoreCopyBatch = db.batch();
      batchCounter = 0;
    }
  }

  if (batchCounter > 0) {
    await firestoreCopyBatch.commit();
  }
};

const resetAccountCalcFlag = async (versionRef: FirebaseFirestore.DocumentReference, calcType: string) => {
  const acctQuerySnap = await versionRef.collection('dept').where('calc_type', '==', calcType).get();
  for (const acctDoc of acctQuerySnap.docs) {
    acctDoc.ref.update({ calc_type: 'entry' });
  }
};
