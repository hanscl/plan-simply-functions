import * as admin from 'firebase-admin';

import { RollingForecastRequest } from './rolling_forecast_model';
import { beginRollVersion } from '../roll_version/roll_version';
import { RollVersionRequest } from '../roll_version/roll_version_model';
// import { completeRebuildAndRecalcVersion } from '../version_complete_rebuild';
import {versionDoc } from '../plan_model';
import {initVersionCalendar} from '../utils/version_calendar';

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

      const newVersionRef = entityDoc.ref.collection('plans').doc(targetPlanVersion.targetPlanId).collection('versions').doc(targetPlanVersion.targetVersionId);

      // do all the rolling stuff
      await updateVersionCalendar(newVersionRef);

      // await completeRebuildAndRecalcVersion({
      //   entityId: entityDoc.id,
      //   planId: targetPlanVersion.targetPlanId,
      //   versionId: targetPlanVersion.targetVersionId,
      // });
    }
  } catch (error) {
    throw new Error(`Error occured in [beginRollingForecast]: ${error}`);
  }
};

const updateVersionCalendar = async(versionRef: FirebaseFirestore.DocumentReference) => {
  const versionSnap = await versionRef.get();
  if(!versionSnap.exists) {
    throw new Error(`Unable to load version document in [updateVersionCalendar]`);
  }
  const versionDoc = versionSnap.data() as versionDoc;
  if(!versionDoc.begin_month || !versionDoc.begin_year) {
    throw new Error(`Missing calendar in version document [updateVersionCalendar]`);
  }

  let newBeginMonth = ++versionDoc.begin_month;
  let newBeginYear = versionDoc.begin_year; 

  if(newBeginMonth > 12) {
    newBeginMonth = 1;
    newBeginYear++;
  }

  const updatedVersionCalendar = initVersionCalendar(newBeginMonth, newBeginYear);

  await versionRef.update({begin_month: newBeginMonth, begin_year: newBeginYear, periods: updatedVersionCalendar});
}

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
