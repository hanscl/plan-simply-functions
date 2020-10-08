import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as labor_model from "./labor_model";
import * as plan_model from "./plan_model";
import * as utils from "./utils";

const db = admin.firestore();

interface contextParams {
  entity_id: string;
  position_id: string;
  plan_id?: string;
  version_id: string;
}

export const laborEntryUpdate = functions.firestore
  .document("entities/{entityId}/labor/{versionId}/positions/{positionId}")
  .onWrite(async (snapshot, context) => {
    try {
      const context_params: contextParams = {
        entity_id: context.params.entityId,
        position_id: context.params.positionId,
        version_id: context.params.versionId,
      };

      const pos_doc_before = snapshot.before.data() as labor_model.positionDoc;
      const pos_doc_after = snapshot.after.data() as labor_model.positionDoc;

      if (pos_doc_after === undefined) return;

      // Exit function if document didn't change
      if (JSON.stringify(pos_doc_before) === JSON.stringify(pos_doc_after)) {
        console.log(
          `Position document ${context_params.position_id} for entity ${context_params.entity_id} and version ${context_params.version_id} did not change. Do nothing.`
        );
        return;
      }

      // Exit function if any required values are missing
      if (
        pos_doc_after.rate === undefined ||
        pos_doc_after.status === undefined ||
        pos_doc_after.ftes === undefined ||
        pos_doc_after.fte_factor === undefined
      ) {
        console.log(
          `Position document ${context_params.position_id} for entity ${context_params.entity_id} and version ${context_params.version_id} is missing required fields or values. Cannot process.`
        );
        return;
      }

      // Ensure that ONLY input values have changed
      if (pos_doc_before !== undefined) {
        if (
          pos_doc_before.acct === pos_doc_after.acct &&
          pos_doc_before.dept === pos_doc_after.dept &&
          pos_doc_before.fte_factor === pos_doc_after.fte_factor &&
          JSON.stringify(pos_doc_before.ftes?.values) === JSON.stringify(pos_doc_after.ftes?.values) &&
          pos_doc_before.pos === pos_doc_after.pos &&
          pos_doc_before.status === pos_doc_after.status
        ) {
          if (
            (pos_doc_after.status === "Hourly" && pos_doc_before.rate !== undefined && pos_doc_before.rate.hourly === pos_doc_after.rate.hourly) ||
            (pos_doc_after.status === "Salary" && pos_doc_before.rate !== undefined && pos_doc_before.rate.annual === pos_doc_after.rate.annual)
          ) {
            console.log(`All input values are unchanged. Exit`);
            return;
          }
        }
      }

      // Save plan id ...
      const labor_snap = await db.doc(`entities/${context_params.entity_id}/labor/${context_params.version_id}`).get();
      if (!labor_snap.exists) throw new Error(`Could not get labor doc with version id ${context_params.version_id}. Fatal Error.`);
      context_params.plan_id = (labor_snap.data() as labor_model.laborVersionDoc).plan_id;
      // ... and also get the plan document
      const plan_snap = await db.doc(`entities/${context_params.entity_id}/plans/${context_params.plan_id}`).get();
      if (!plan_snap.exists) throw new Error(`Plan document ${context_params.plan_id} does not exists for entity ${context_params.entity_id}. Exiting.`);
      const plan_doc = plan_snap.data() as plan_model.planDoc;

      const days_in_months = utils.getDaysInMonth(plan_doc.begin_year, plan_doc.begin_month);
      console.log(`Days in plan months are: ${JSON.stringify(days_in_months)}`);

      calculateWages(pos_doc_after, days_in_months);
      calculateAvgFTEs(days_in_months, pos_doc_after.ftes);
      calculateRate(pos_doc_after);

      // write updated document
      await labor_snap.ref.collection("positions").doc(context_params.position_id).update(pos_doc_after);

      // now update the gl account => ONLY if we have values for ACCT and DEPT
      if (pos_doc_after.acct !== undefined && pos_doc_after.dept !== undefined) {
        await recalcGlAccount(context_params, pos_doc_after);
        // ... also if either ACCT/DEPT (or both) changed, then we need to recalculate the combination where the position was removed from
        if (pos_doc_before.acct !== pos_doc_after.acct || pos_doc_before.dept !== pos_doc_after.dept)
          await recalcGlAccount(context_params, pos_doc_before);
      }

      // If there are no more blank positions, add one more
      // TODO: Remove when we have add additional labor positions in the UI
      const pos_snap = await db
        .collection(`entities/${context_params.entity_id}/labor/${context_params.version_id}/positions`)
        .where("acct", "==", "")
        .where("dept", "==", "")
        .where("pos", "==", "")
        .get();

      if (pos_snap.empty) {
        const empty_labor_pos: labor_model.positionDoc = {
          pos: "",
          acct: "",
          dept: "",
          fte_factor: 0,
          ftes: { total: 0, values: utils.getValuesArray() },
          rate: { annual: 0, hourly: 0 },
          status: "Hourly",
        };
        await db.collection(`entities/${context_params.entity_id}/labor/${context_params.version_id}/positions`).add(empty_labor_pos);
      
      }
    } catch (error) {
      console.log(`Error occured while processing labor update: ${error}`);
    }
  });

function calculateWages(position: labor_model.positionDoc, days_in_months: number[]) {
  if (position.wages === undefined) {
    position.wages = { total: 0, values: utils.getValuesArray() };
  }
  if (position.ftes === undefined) {
    console.log(`trying to calculate wages without FTEs`);
    return;
  }
  if (position.rate === undefined) {
    console.log(`trying to calculate wages without a rate`);
    return;
  }
  if (position.status === "Hourly" && position.fte_factor === undefined) {
    console.log(`trying to calculate hourly wages without an FTE factor `);
    return;
  }
  const days_in_year = days_in_months.reduce((a, b) => {
    return a + b;
  }, 0);
  position.wages.total = 0;
  for (let mnth_idx = 0; mnth_idx < 12; mnth_idx++) {
    if (position.status === "Salary" && position.rate.annual !== undefined) {
      position.wages.values[mnth_idx] = (days_in_months[mnth_idx] / days_in_year) * position.ftes.values[mnth_idx] * position.rate.annual;
      position.wages.total += position.wages.values[mnth_idx];
      position.wages.values[mnth_idx] = utils.finRound(position.wages.values[mnth_idx]);
      100;
    } else if (position.status === "Hourly" && position.fte_factor !== undefined && position.rate.hourly !== undefined) {
      position.wages.values[mnth_idx] = days_in_months[mnth_idx] * (position.fte_factor / 52 / 7) * position.ftes.values[mnth_idx] * position.rate.hourly;
      position.wages.total += position.wages.values[mnth_idx];
      position.wages.values[mnth_idx] = utils.finRound(position.wages.values[mnth_idx]);
    }
  }
  position.wages.total = utils.finRound(position.wages.total);
}

function calculateAvgFTEs(days_in_months: number[], ftes: labor_model.laborCalc) {
  const days_in_year = days_in_months.reduce((a, b) => {
    return a + b;
  }, 0);

  let avg_ftes = 0;
  for (let mnth_idx = 0; mnth_idx < 12; mnth_idx++) {
    avg_ftes += ftes.values[mnth_idx] * (days_in_months[mnth_idx] / days_in_year);
  }

  ftes.total = utils.finRound(avg_ftes);
}

function calculateRate(position: labor_model.positionDoc) {
  if (position.rate === undefined || position.fte_factor === undefined) return;

  if (position.status === "Hourly" && position.rate.hourly !== undefined) {
    position.rate.annual = utils.finRound(position.rate.hourly * position.fte_factor);
  } else if (position.status === "Salary" && position.rate.annual !== undefined) {
    position.rate.hourly = utils.finRound(position.rate.annual / position.fte_factor);
  }
}

async function recalcGlAccount(context_params: contextParams, updated_position: labor_model.positionDoc) {
  // get all positions accounts for the same dept and acct
  const pos_snap = await db
    .collection(`entities/${context_params.entity_id}/labor/${context_params.version_id}/positions`)
    .where("acct", "==", updated_position.acct)
    .where("dept", "==", updated_position.dept)
    .get();

  // create a labor flag => if no labor positions exist anymore, then this will stay false so that we flag the GL account correctly
  let labor_calc_flag = "entry";
  const updated_values = utils.getValuesArray();
  for (const curr_pos_doc of pos_snap.docs) {
    const curr_wages = (curr_pos_doc.data() as labor_model.positionDoc).wages;
    if (curr_wages === undefined) continue;
    for (let idx = 0; idx < updated_values.length; idx++) {
      updated_values[idx] += curr_wages.values[idx];
    }
    labor_calc_flag = "labor";
  }

  // update the account doc
  const acct_snap = await db
    .collection(`entities/${context_params.entity_id}/plans/${context_params.plan_id}/versions/${context_params.version_id}/dept`)
    .where("acct", "==", updated_position.acct)
    .where("dept", "==", updated_position.dept)
    .get();

  if (acct_snap.empty) {
    console.log(
      `Version ${context_params.version_id} in plan ${context_params.plan_id} of entity ${context_params.entity_id} does not have the following dept:acct combination: ${updated_position.dept}:${updated_position.acct}. Wages not updated in version.`
    );
    return;
  }

  // otherwise take the first account (since there should only be one) and update!
  await acct_snap.docs[0].ref.update({
    values: updated_values,
    calc_type: labor_calc_flag,
  });
}
