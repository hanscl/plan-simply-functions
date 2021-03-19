import * as admin from 'firebase-admin';

import { RollingForecastForEntity } from './rolling_forecast_model';
import { beginRollVersion } from '../roll_version/roll_version';
import { RollVersionForEntity } from '../roll_version/roll_version_model';
import { accountDoc, versionDoc } from '../plan_model';
import { initVersionCalendar } from '../utils/version_calendar';
import { PositionDoc } from '../labor/labor_model';
import { acctDriverDef } from '../driver_model';
import { completeRebuildAndRecalcVersion } from '../version_complete_rebuild';

const db = admin.firestore();

export const beginRollingForecast = async (rollingForecastRequest: RollingForecastForEntity) => {
  try {
    const entityDoc = await db.doc(`entities/${rollingForecastRequest.entityId}`).get();
    if (!entityDoc.exists) {
      throw new Error(`Could not find entity ${rollingForecastRequest.entityId} at [beginRollingForecast]. Aborting`);
    }

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
    const { seedMonth } = rollingForecastRequest;
    const relativeSeedMonth = await updateVersionCalendar(newVersionRef, seedMonth);

    
    await updateAccountEntries(newVersionRef, relativeSeedMonth);
    await updateLaborPositions(entityDoc.id, targetPlanVersion.targetVersionId, relativeSeedMonth);
    await updateDrivers(entityDoc.id, targetPlanVersion.targetVersionId, relativeSeedMonth);

    await completeRebuildAndRecalcVersion(
      {
        entityId: entityDoc.id,
        planId: targetPlanVersion.targetPlanId,
        versionId: targetPlanVersion.targetVersionId,
      },
      true
    );
  } catch (error) {
    throw new Error(`Error occured in [beginRollingForecast]: ${error}`);
  }
};

const updateDrivers = async (entityId: string, versionId: string, seedMonth: number) => {
  try {
    let batch = db.batch();
    let txCtr = 0;

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
        txCtr++;
      }
      if (txCtr > 400) {
        await batch.commit();
        batch = db.batch();
        txCtr = 0;
      }
    }
    if (txCtr > 0) {
      await batch.commit();
    }
  } catch (error) {
    throw new Error(`Error occured in [updateDrivers]: ${error}`);
  }
};

const updateLaborPositions = async (entityId: string, versionId: string, seedMonth: number) => {
  try {
    let batch = db.batch();
    let txCtr = 0;

    const laborPositionSnap = await db.collection(`entities/${entityId}/labor/${versionId}/positions`).get();

    for (const positionDoc of laborPositionSnap.docs) {
      const position = positionDoc.data() as PositionDoc;

      position.ftes.values.push(position.ftes.values[seedMonth - 1]);
      position.ftes.values.shift();

      if (position.bonus_option === 'Value') {
        position.bonus.values.push(position.bonus.values[seedMonth - 1]);
        position.bonus.values.shift();
      }
      batch.update(positionDoc.ref, { bonus: position.bonus, ftes: position.ftes });
      txCtr++;

      if (txCtr > 400) {
        await batch.commit();
        batch = db.batch();
        txCtr = 0;
      }
    }
    if (txCtr > 0) {
      await batch.commit();
    }
  } catch (error) {
    throw new Error(`Error occured in [updateLaborPositions]: ${error}`);
  }
};

const updateAccountEntries = async (versionRef: FirebaseFirestore.DocumentReference, seedMonth: number) => {
  try {
    let batch = db.batch();
    let txCtr = 0;

    const accountQuerySnap = await versionRef.collection('dept').where('class', '==', 'acct').get();
    for (const nLevelAcctDoc of accountQuerySnap.docs) {
      const account = nLevelAcctDoc.data() as accountDoc;
      if (!account.calc_type || account.calc_type === 'entry') {
        account.values.push(account.values[seedMonth - 1]);
        account.values.shift();
        batch.update(nLevelAcctDoc.ref, { values: account.values });
        txCtr++;
      }
      if (txCtr > 400) {
        await batch.commit();
        batch = db.batch();
        txCtr = 0;
      }
    }
    if (txCtr > 0) {
      await batch.commit();
    }
  } catch (error) {
    throw new Error(`Error occured in [updateAccountEntries]: ${error}`);
  }
};

const updateVersionCalendar = async (versionRef: FirebaseFirestore.DocumentReference, seedMonth: number) => {
  try {
    const versionSnap = await versionRef.get();
    if (!versionSnap.exists) {
      throw new Error(`Unable to load version document in [updateVersionCalendar]`);
    }
    const versionDocData = versionSnap.data() as versionDoc;
    if (!versionDocData.begin_month || !versionDocData.begin_year) {
      throw new Error(`Missing calendar in version document [updateVersionCalendar]`);
    }

    let newBeginMonth = versionDocData.begin_month + 1;
    let newBeginYear = versionDocData.begin_year;

    if (newBeginMonth > 12) {
      newBeginMonth = 1;
      newBeginYear++;
    }

    const updatedVersionCalendar = initVersionCalendar(newBeginMonth, newBeginYear);

    await versionRef.update({ begin_month: newBeginMonth, begin_year: newBeginYear, periods: updatedVersionCalendar });

    // offset seed month for original version & return
    let relativeSeedMonthNumber = (seedMonth - versionDocData.begin_month) + 1;
    if(relativeSeedMonthNumber <= 0) {
      relativeSeedMonthNumber += 12;
    }
    console.log(`Seed month of ${seedMonth} has been offset to ${relativeSeedMonthNumber} to match source version`);

    return relativeSeedMonthNumber;

  } catch (error) {
    throw new Error(`Error occured in [updateVersionCalendar]: ${error}`);
  }
};

const copyVersionWithoutChanges = async (entityId: string, rollingForecastRequest: RollingForecastForEntity) => {
  try {
    const rollVersionRequest: RollVersionForEntity = {
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
  } catch (error) {
    throw new Error(`Error occured in [copyVersionWithoutChanges]: ${error}`);
  }
};
