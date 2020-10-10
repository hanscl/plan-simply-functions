import * as admin from "firebase-admin";
import * as driver_model from "./driver_model";
import * as plan_model from "./plan_model";
import * as utils from "./utils";

const db = admin.firestore();

interface recalcParams {
    entity_id: string;
    plan_id: string;
    version_id: string;
    acct_id: string;
    values: number[];
}

export async function versionRollupRecalc(recalc_params: recalcParams) {
try {

    // Begin by checking if

    await db.runTransaction(async (driver_tx) => {
      // (1) Resolve the first driver to a numbers array (call get AccoutnValuye)
      console.log(`before loop: ${JSON.stringify(driver_def)}`);
      let last_result: number[] = await getAccountValue(driver_tx, driver_def.drivers[0], driver_params);

      for (let idx = 0; idx < driver_def.operations.length; idx++) {
        console.log(`inside loop with index ${idx}: ${JSON.stringify(driver_def)}`);
        last_result = await processDriverCombination(driver_tx, driver_params, last_result, driver_def.operations[idx], driver_def.drivers[idx + 1]);
      }

      // get the document reference and update using transaction
      const acct_doc_ref = db.doc(
        `entities/${driver_params.entity_id}/plans/${driver_params.plan_id}/versions/${driver_params.version_id}/dept/${driver_params.acct_id}`
      );
      driver_tx.update(acct_doc_ref, { values: last_result, calc_type: "driver" });
    });
  } catch (e) {
    console.log("Transaction failure:", e);
  }
}

async function isUpdatedAllowed(recalc_params) {
    
}