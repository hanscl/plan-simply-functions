import * as admin from 'firebase-admin';

import { RollingForecastRequest } from './rolling_forecast_model';
import { beginRollVersion } from '../roll_version/roll_version';
import { RollVersionRequest } from '../roll_version/roll_version_model';
// import { completeRebuildAndRecalcVersion } from '../version_complete_rebuild';
import { accountDoc, versionDoc } from '../plan_model';
import { initVersionCalendar } from '../utils/version_calendar';
import { PositionDoc } from '../labor/labor_model';
import { acctDriverDef } from '../driver_model';
import { completeRebuildAndRecalcVersion } from '../version_complete_rebuild'

const db = admin.firestore();

export const beginRollingForecast = async (rollingForecastRequest: RollingForecastRequest) => {
  try {
    let query = db.collection(`entities`).where('type', '==', 'entity');
    if (rollingForecastRequest.entityId) {
      query = query.where(admin.firestore.FieldPath.documentId(), '==', rollingForecastRequest.entityId);
    }
    const entityCollectionSnapshot = await query.get();

    for (const entityDoc of entityCollectionSnapshot.docs) {
      const targetPlanVersion = await copyVersionWithoutChanges(entityDoc.id, rollingForecastRequest);
      if (!targetPlanVersion) {
        throw new Error(`Error occured in [beginRollingForecast]: rolling Version did not succeed`);
      }

      const newVersionRef = entityDoc.ref
        .collection('plans')
        .doc(targetPlanVersion.targetPlanId)
        .collection('versions')
        .doc(targetPlanVersion.targetVersionId);

      // do all the rolling stuff
      await updateVersionCalendar(newVersionRef);

      const { seedMonth } = rollingForecastRequest;
      await updateAccountEntries(newVersionRef, seedMonth);
      await updateLaborPositions(entityDoc.id, targetPlanVersion.targetVersionId, seedMonth);
      await updateDrivers(entityDoc.id, targetPlanVersion.targetVersionId, seedMonth);
      
      await completeRebuildAndRecalcVersion({
        entityId: entityDoc.id,
        planId: targetPlanVersion.targetPlanId,
        versionId: targetPlanVersion.targetVersionId,
      });
    }
  } catch (error) {
    throw new Error(`Error occured in [beginRollingForecast]: ${error}`);
  }
};

const updateDrivers = async (entityId: string, versionId: string, seedMonth: number) => {
  const batch = db.batch();

  const driverSnap = await db.collection(`entities/${entityId}/drivers/${versionId}/dept`).get();

  for (const driverDoc of driverSnap.docs) {
    const driver = driverDoc.data() as acctDriverDef;
    let updateThisDriverDoc = false;

    for (const driverEntry of driver.drivers) {
      if (driverEntry.type === 'value') {
        updateThisDriverDoc = true;
        const driverValArr = driverEntry.entry as number[];
        driverValArr.push(driverValArr[seedMonth - 1]);
        driverValArr.shift();
      }
    }

    if (updateThisDriverDoc) {
      batch.update(driverDoc.ref, { drivers: driver.drivers });
    }
  }
  await batch.commit();
};

const updateLaborPositions = async (entityId: string, versionId: string, seedMonth: number) => {
  const batch = db.batch();

  const laborPositionSnap = await db.collection(`entities/${entityId}/labor/${versionId}/positions`).get();

  for (const positionDoc of laborPositionSnap.docs) {
    const position = positionDoc.data() as PositionDoc;

    position.ftes.values.push(position.ftes.values[seedMonth - 1]);
    position.ftes.values.shift;

    if (position.bonus_option === 'Value') {
      position.bonus.values.push(position.bonus.values[seedMonth - 1]);
      position.bonus.values.shift;
    }
    batch.update(positionDoc.ref, { bonus: position.bonus, ftes: position.ftes });
  }
  await batch.commit();
};

const updateAccountEntries = async (versionRef: FirebaseFirestore.DocumentReference, seedMonth: number) => {
  const batch = db.batch();

  const accountQuerySnap = await versionRef.collection('dept').where('class', '==', 'acct').get();
  for (const nLevelAcctDoc of accountQuerySnap.docs) {
    const account = nLevelAcctDoc.data() as accountDoc;
    if (!account.calc_type || account.calc_type === 'entry') {
      account.values.push(account.values[seedMonth - 1]);
      account.values.shift();

      batch.update(nLevelAcctDoc.ref, { values: account.values });
    }
  }
  await batch.commit();
};

const updateVersionCalendar = async (versionRef: FirebaseFirestore.DocumentReference) => {
  const versionSnap = await versionRef.get();
  if (!versionSnap.exists) {
    throw new Error(`Unable to load version document in [updateVersionCalendar]`);
  }
  const versionDoc = versionSnap.data() as versionDoc;
  if (!versionDoc.begin_month || !versionDoc.begin_year) {
    throw new Error(`Missing calendar in version document [updateVersionCalendar]`);
  }

  let newBeginMonth = ++versionDoc.begin_month;
  let newBeginYear = versionDoc.begin_year;

  if (newBeginMonth > 12) {
    newBeginMonth = 1;
    newBeginYear++;
  }

  const updatedVersionCalendar = initVersionCalendar(newBeginMonth, newBeginYear);

  await versionRef.update({ begin_month: newBeginMonth, begin_year: newBeginYear, periods: updatedVersionCalendar });
};

const copyVersionWithoutChanges = async (entityId: string, rollingForecastRequest: RollingForecastRequest) => {
  const rollVersionRequest: RollVersionRequest = {
    copyDrivers: true,
    copyLaborPositions: true,
    lockSourceVersion: true,
    entityId: entityId,
    sourcePlanVersion: {
      planName: rollingForecastRequest.planName,
      versionName: rollingForecastRequest.sourceVersionName,
    },
    targetPlanVersion: {
      planName: rollingForecastRequest.planName,
      versionName: rollingForecastRequest.targetVersionName,
    },
  };
  return await beginRollVersion(rollVersionRequest, false);
};
