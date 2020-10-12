import * as admin from "firebase-admin";
import * as plan_model from "./plan_model";
import * as utils from "./utils";
import * as version_recalc_slave from "./version_rollup_recalc_slave";
import * as rollup_entity_account_update from "./rollup_entity_account_update";
import * as driver_calc from "./driver_calc";

const db = admin.firestore();

interface recalcParams {
  entity_id: string;
  plan_id: string;
  version_id: string;
  acct_id: string;
  values: number[];
  dept?: string;
}

export async function beginVersionRollupRecalc(recalc_params: recalcParams, user_initiated: boolean) {
  try {
    // Begin by checking if version editing is allowed
    console.log(`calling isUpdateAllowed with user_init: ${user_initiated} and ${JSON.stringify(recalc_params)}`);
    if (user_initiated && !(await isUpdatedAllowed(recalc_params))) {
      console.log(`user initiated and no updated allowed. Exit`);
      return;
    }
  
    console.log(`Before Transaction: Updating acct ${recalc_params.acct_id} to ${JSON.stringify(recalc_params.values)}`);
    // begin transaction - lock the version document until we're done
    const acct_changes = await db.runTransaction(async (recalc_tx) => {
      const version_doc = await recalc_tx.get(
        db.doc(`entities/${recalc_params.entity_id}/plans/${recalc_params.plan_id}/versions/${recalc_params.version_id}`)
      );

      // Abort if the version has not been initialized
      if ((version_doc.data() as plan_model.versionDoc).calculated !== true) {
        console.log(`Version has never been fully calculated/initialized. Aborting incremental recalc`);
        return undefined;
      }

      // perform recalc in here to ensure no other update runs concurrently on this version
      const recalc_res = await version_recalc_slave.executeVersionRollupRecalc(recalc_params, recalc_tx);

      recalc_tx.update(version_doc.ref, { last_update: admin.firestore.Timestamp.now() });

      return recalc_res;
    });

    /**** ADDITIONAL CALCS FOLLOW BELOW => THESE ARE DONE OUTSIDE OF THIS TX TO NOT LOCK THE VERSION LONGER THAN NEEDED */
    // now update the account in any direct parent/rollup entity
    if (acct_changes === undefined) {
      console.log("Acct values did not change. Nothing else to be done");
      return;
    }
    await rollup_entity_account_update.updateAccountInRollupEntities(recalc_params, acct_changes);

    // TODO move out of this functino to avoid slow updates
    await driver_calc.recalcDependentDrivers(recalc_params.entity_id, recalc_params.plan_id, recalc_params.version_id, recalc_params.acct_id);

    console.log(`Completed updating acct with values: ${JSON.stringify(recalc_params.values)}`);
  } catch (error) {
    console.log(`Failure at beginVersionRollupRecalc: ${error}`);
  }
}

async function isUpdatedAllowed(recalc_params: recalcParams): Promise<boolean> {
  try {
    // (1) Check version lock
    const version_doc = await db.doc(`entities/${recalc_params.entity_id}/plans/${recalc_params.plan_id}/versions/${recalc_params.version_id}`).get();
    if (!version_doc.exists) throw new Error("Could not read version document. This must be a code error?");
    const version = version_doc.data() as plan_model.versionDoc;
    console.log(`update allowed check version doc: ${JSON.stringify(version)}`);
    if (version.is_locked.all === true) return false;

    console.log(`checking account lock`);
    // (2) Check account lock
    const acct_doc = await version_doc.ref.collection("dept").doc(recalc_params.acct_id).get();
    if (!acct_doc.exists) throw new Error("Could not read account document. This must be a code error?");
    const acct_obj = acct_doc.data() as plan_model.accountDoc;
    if (acct_obj.is_locked === true) return false;

    // (3) Check period (calc differences)
    const diff_by_month: number[] = [];
    const months_changed: number[] = [];
    if (utils.getValueDiffsByMonth(acct_obj.values, recalc_params.values, diff_by_month, months_changed) === undefined) return false;
    for (const idx of months_changed) {
      if (version.is_locked.periods[idx] === true) return false;
    }

    console.log(`Version editing allowed for ${recalc_params.entity_id}:${recalc_params.version_id}:${recalc_params.acct_id}`);
    return true;
  } catch (error) {
    console.log(`Error occurred while checking if udpate is allowed`);
    return false;
  }
}
