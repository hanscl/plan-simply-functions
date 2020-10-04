import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as plan_model from "./plan_model";
import * as view_model from "./view_model";
import * as utils from "./utils";
import * as entity_model from "./entity_model";

interface parentAccounts {
  type: "dept" | "div";
  acct_id: string;
  acct_obj?: plan_model.accountDoc;
}

interface acctChanges {
  diffByMonth: number[];
  diffTotal: number;
  months_changed: number[];
  operation: number;
}

interface versionParams {
  entity_id: string;
  version_id: string;
  plan_id: string;
  acct_id: string;
}

interface docRefs {
  entity: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>;
  plan: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>;
  version: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>;
  acct: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>;
}

interface acctValues {
  total: number;
  values: number[];
}

const db = admin.firestore();

export async function versionRecalcManual(version_params: versionParams, period_values: number[]) {
  try {
    // create object with new values and calculate the new total
    const acct_vals_after: acctValues = {
      values: period_values,
      total: period_values.reduce((a, b) => {
        return a + b;
      }, 0),
    };

    // get the reference to the n_level account
    const entity_ref = db.doc(`entities/${version_params.entity_id}`);
    const plan_ref = entity_ref.collection("plans").doc(version_params.plan_id);
    const version_ref = plan_ref.collection("versions").doc(version_params.version_id);
    const acct_ref = version_ref.collection("dept").doc(version_params.acct_id);

    const doc_refs: docRefs = {
      entity: entity_ref,
      plan: plan_ref,
      version: version_ref,
      acct: acct_ref,
    };

    // ***TRANSACTION*** BEGIN to ensure no concurrent writes interfere with the incremental calculation
    const tx_res = await db.runTransaction(async (tx_acct) => {
      // get the account document & data
      const acct_doc = await tx_acct.get(doc_refs.acct);
      const nlevel_acct_before = acct_doc.data() as plan_model.accountDoc;

      // calculate the difference from before to after => if nothing changes let's finish up
      const acct_changes = calculateAcctChanges({ total: nlevel_acct_before.total, values: nlevel_acct_before.values }, acct_vals_after);
      if (acct_changes.months_changed.length === 0) {
        return "test";
      }

      // We have safely calculated the changes without concurrent writes => update the document and end the transaction
      tx_acct.update(doc_refs.acct, { is_driver_calc: true, total: acct_vals_after.total, values: acct_vals_after.values });
      return;
    }); // END Transaction

    // handle non-fatal errors that occured during the transaction
    if (tx_res !== undefined) {
      console.log(tx_res);
      return;
    }

    // continue on
    
  } catch (error) {
    console.log("Error occured during manual (non-triggered) recalc of version: " + error);
    return;
  }
}

function calculateAcctChanges(acct_vals_before: acctValues, acct_vals_after: acctValues): acctChanges {
  // initialize variables for tracking changes in monthly data
  const diffByMonth: number[] = [];
  const months_changed: number[] = [];
  let diffTotal = 0;

  // calculate difference for each month and track which months changed
  for (let periodIdx = 0; periodIdx < acct_vals_before.values.length; periodIdx++) {
    diffByMonth[periodIdx] = acct_vals_after.values[periodIdx] - acct_vals_before.values[periodIdx];
    if (diffByMonth[periodIdx] !== 0) {
      months_changed.push(periodIdx);
      diffTotal += diffByMonth[periodIdx];
    }
  }

  return {
    diffByMonth: diffByMonth,
    diffTotal: diffTotal,
    months_changed: months_changed,
    operation: 1,
  };
}
