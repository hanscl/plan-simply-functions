import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as labor_model from "./labor_model";
import * as plan_model from "../plan_model";
import * as utils from "../utils";
import * as entity_model from "../entity_model";
import * as version_recalc from "../version_rollup_recalc_master";

const db = admin.firestore();

interface contextParams {
  entity_id: string;
  position_id: string;
  plan_id?: string;
  version_id: string;
}

export const laborEntryUpdate = functions.firestore
  .document("entities/{entityId}/labor/{versionId}/positions/TEST123")
  .onWrite(async (snapshot, context) => {
    try {
      const context_params: contextParams = {
        entity_id: context.params.entityId,
        position_id: context.params.positionId,
        version_id: context.params.versionId,
      };

      const pos_doc_before = snapshot.before.data() as labor_model.PositionDoc;
      const pos_doc_after = snapshot.after.data() as labor_model.PositionDoc;

      console.log(`Position doc before: ${JSON.stringify(pos_doc_before)}`);
      console.log(`Position doc after: ${JSON.stringify(pos_doc_after)}`);

      // Save plan id ...
      const labor_snap = await db.doc(`entities/${context_params.entity_id}/labor/${context_params.version_id}`).get();
      if (!labor_snap.exists) throw new Error(`Could not get labor doc with version id ${context_params.version_id}. Fatal Error.`);
      context_params.plan_id = (labor_snap.data() as labor_model.laborVersionDoc).plan_id;
      // ... and also get the plan document
      const plan_snap = await db.doc(`entities/${context_params.entity_id}/plans/${context_params.plan_id}`).get();
      if (!plan_snap.exists) throw new Error(`Plan document ${context_params.plan_id} does not exists for entity ${context_params.entity_id}. Exiting.`);
      const plan_doc = plan_snap.data() as plan_model.planDoc;

      if (pos_doc_after === undefined && pos_doc_before !== undefined && pos_doc_before.dept !== undefined && pos_doc_before.acct !== undefined) {
        await recalcGlAccount(context_params, pos_doc_before);
        return;
      }

      // if (pos_doc_after.is_updating === true || (pos_doc_before.is_updating === true && pos_doc_after.is_updating === false)) {
      //   console.log(`update in progress already.exit`);
      //   return;
      // }

      // await snapshot.after.ref.update({ is_updating: true });

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
        pos_doc_after.pay_type === undefined ||
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
          pos_doc_before.title === pos_doc_after.title &&
          pos_doc_before.pay_type === pos_doc_after.pay_type
        ) {
          if (
            (pos_doc_after.pay_type === "Hourly" && pos_doc_before.rate !== undefined && pos_doc_before.rate.hourly === pos_doc_after.rate.hourly) ||
            (pos_doc_after.pay_type === "Salary" && pos_doc_before.rate !== undefined && pos_doc_before.rate.annual === pos_doc_after.rate.annual)
          ) {
            console.log(`All input values are unchanged. Exit`);
            return;
          }
        }
      }

      const days_in_months = utils.getDaysInMonth(plan_doc.begin_year, plan_doc.begin_month);
      console.log(`Days in plan months are: ${JSON.stringify(days_in_months)}`);


      

      const entity_doc = await db.doc(`entities/${context_params.entity_id}`).get();
      if (!entity_doc.exists) throw new Error(`no entity doc found for [entities/${context_params.entity_id}]`);
      const entity_labor_calcs = (entity_doc.data() as entity_model.entityDoc).labor_settings;
      if(entity_labor_calcs === undefined) throw new Error(`Labor calcs do not exist on entity ${context_params.entity_id}`);
      const wage_method = entity_labor_calcs.wage_method;
      if (wage_method === "us") calculateWagesUS(pos_doc_after, days_in_months);
      else calculateWagesEU(pos_doc_after);
      calculateAvgFTEs(days_in_months, pos_doc_after.ftes);
      calculateRate(pos_doc_after);

            // set/update the div on the position
      const docPath = `entities/${context_params.entity_id}/entity_structure/dept`;
      const deptDoc = await db.doc(docPath).get();
      if(!deptDoc.exists) throw new Error(`Dept definition document not found in entity structure: ${docPath}`);
      if(pos_doc_after.dept !== undefined) {
        console.log(`deptdoc found -- finding div for pos`);
        const deptDict = deptDoc.data() as entity_model.deptDict;
        const divId = deptDict[pos_doc_after.dept].div;
        if(!divId) throw new Error(`could not find divID for ${pos_doc_after.dept}`);
        console.log(`DIV ID for position is ${divId}`);
        pos_doc_after.div = divId;
      } else {
        console.log(`no dept doc found or dept of pos undefined`);
      }

      // write updated document
      // pos_doc_after.is_updating = false;
      await labor_snap.ref.collection("positions").doc(context_params.position_id).update(pos_doc_after);

      if (pos_doc_after.acct !== undefined && pos_doc_after.dept !== undefined) {
        await recalcGlAccount(context_params, pos_doc_after);
        // ... also if either ACCT/DEPT (or both) changed, then we need to recalculate the combination where the position was removed from
        if (
          (pos_doc_before.acct !== pos_doc_after.acct || pos_doc_before.dept !== pos_doc_after.dept) &&
          pos_doc_before.acct !== undefined &&
          pos_doc_before.dept !== undefined
        )
          await recalcGlAccount(context_params, pos_doc_before);
      }
    } catch (error) {
      console.log(`Error occured while processing labor update: ${error}`);
    }
  });

function calculateWagesEU(position: labor_model.PositionDoc) {
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
  if (position.pay_type === "Hourly" && position.fte_factor === undefined) {
    console.log(`trying to calculate hourly wages without an FTE factor `);
    return;
  }

  position.wages.total = 0;
  for (let mnth_idx = 0; mnth_idx < 12; mnth_idx++) {
    if (position.pay_type === "Salary" && position.rate.annual !== undefined) {
      position.wages.values[mnth_idx] = position.ftes.values[mnth_idx] * (position.rate.annual / 12);
      position.wages.total += position.wages.values[mnth_idx];
      position.wages.values[mnth_idx] = utils.finRound(position.wages.values[mnth_idx]);
      100;
    } else if (position.pay_type === "Hourly" && position.fte_factor !== undefined && position.rate.hourly !== undefined) {
      position.wages.values[mnth_idx] = (position.fte_factor * position.rate.hourly) / 12 * position.ftes.values[mnth_idx];
      position.wages.total += position.wages.values[mnth_idx];
      position.wages.values[mnth_idx] = utils.finRound(position.wages.values[mnth_idx]);
    }
  }
  position.wages.total = utils.finRound(position.wages.total);
  console.log(`wage calc complete`);
}

function calculateWagesUS(position: labor_model.PositionDoc, days_in_months: number[]) {
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
  if (position.pay_type === "Hourly" && position.fte_factor === undefined) {
    console.log(`trying to calculate hourly wages without an FTE factor `);
    return;
  }
  const days_in_year = days_in_months.reduce((a, b) => {
    return a + b;
  }, 0);
  position.wages.total = 0;
  for (let mnth_idx = 0; mnth_idx < 12; mnth_idx++) {
    if (position.pay_type === "Salary" && position.rate.annual !== undefined) {
      position.wages.values[mnth_idx] = (days_in_months[mnth_idx] / days_in_year) * position.ftes.values[mnth_idx] * position.rate.annual;
      position.wages.total += position.wages.values[mnth_idx];
      position.wages.values[mnth_idx] = utils.finRound(position.wages.values[mnth_idx]);
      100;
    } else if (position.pay_type === "Hourly" && position.fte_factor !== undefined && position.rate.hourly !== undefined) {
      position.wages.values[mnth_idx] = days_in_months[mnth_idx] * (position.fte_factor / 52 / 7) * position.ftes.values[mnth_idx] * position.rate.hourly;
      position.wages.total += position.wages.values[mnth_idx];
      position.wages.values[mnth_idx] = utils.finRound(position.wages.values[mnth_idx]);
    }
  }
  position.wages.total = utils.finRound(position.wages.total);
  console.log(`wage calc complete`);
}

function calculateAvgFTEs(days_in_months: number[], ftes: labor_model.LaborCalc) {
  const days_in_year = days_in_months.reduce((a, b) => {
    return a + b;
  }, 0);

  let avg_ftes = 0;
  for (let mnth_idx = 0; mnth_idx < 12; mnth_idx++) {
    avg_ftes += ftes.values[mnth_idx] * (days_in_months[mnth_idx] / days_in_year);
  }

  ftes.total = utils.finRound(avg_ftes);
  console.log(`avg fte calc complete`);
}

function calculateRate(position: labor_model.PositionDoc) {
  if (position.rate === undefined || position.fte_factor === undefined) return;

  if (position.pay_type === "Hourly" && position.rate.hourly !== undefined) {
    position.rate.annual = utils.finRound(position.rate.hourly * position.fte_factor);
  } else if (position.pay_type === "Salary" && position.rate.annual !== undefined) {
    position.rate.hourly = utils.finRound(position.rate.annual / position.fte_factor);
  }
  console.log(`calculate Rate complete`);
}

async function recalcGlAccount(context_params: contextParams, updated_position: labor_model.PositionDoc) {
  // get all positions accounts for the same dept and acct
  const pos_snap = await db
    .collection(`entities/${context_params.entity_id}/labor/${context_params.version_id}/positions`)
    .where("acct", "==", updated_position.acct)
    .where("dept", "==", updated_position.dept)
    .get();

  //let labor_calc_flag = "entry";
  const updated_values = utils.getValuesArray();
  for (const curr_pos_doc of pos_snap.docs) {
    const curr_wages = (curr_pos_doc.data() as labor_model.PositionDoc).wages;
    if (curr_wages === undefined) continue;
    for (let idx = 0; idx < updated_values.length; idx++) {
      updated_values[idx] += curr_wages.values[idx];
    }
    //  labor_calc_flag = "labor";
  }

  // update the account doc
  // const acct_snap = await db
  //   .collection(`entities/${context_params.entity_id}/plans/${context_params.plan_id}/versions/${context_params.version_id}/dept`)
  //   .where("acct", "==", updated_position.acct)
  //   .where("dept", "==", updated_position.dept)
  //   .get();

  // if (acct_snap.empty) {
  //   console.log(
  //     `Version ${context_params.version_id} in plan ${context_params.plan_id} of entity ${context_params.entity_id} does not have the following dept:acct combination: ${updated_position.dept}:${updated_position.acct}. Wages not updated in version.`
  //   );
  //   return;
  // }

  // get the dept ID from entity structure
  const dept_doc = await db.doc(`entities/${context_params.entity_id}/entity_structure/dept`).get();
  if (!dept_doc.exists) throw new Error(`could not find department doc for ${context_params.entity_id}`);
  const dept_dict = dept_doc.data() as entity_model.deptDict;

  // and the entity document itself
  const entity_doc = await db.doc(`entities/${context_params.entity_id}`).get();
  if (!entity_doc.exists) throw new Error(`could not find department doc for ${context_params.entity_id}`);
  const entity_obj = entity_doc.data() as entity_model.entityDoc;

  if (updated_position.dept === undefined || updated_position.acct === undefined) throw new Error("dept or acct not defined");
  const div = dept_dict[updated_position.dept].div;

  if (div === undefined) throw new Error("div not defined");

  const full_acct = utils.buildFullAccountString([entity_obj.full_account], { acct: updated_position.acct, dept: updated_position.dept, div: div });

  console.log(`full account string built: ${full_acct}`);
  // otherwise take the first account (since there should only be one) and update!
  // await acct_snap.docs[0].ref.update({
  //   calc_type: labor_calc_flag,
  // });

  // and request a recalc
  console.log(`calling recalc rollups with values: ${updated_values}`);
  await version_recalc.beginVersionRollupRecalc(
    {
      acct_id: full_acct,
      entity_id: context_params.entity_id,
      plan_id: context_params.plan_id as string,
      values: updated_values,
      version_id: context_params.version_id,
    },
    false,
    "labor"
  );
}
