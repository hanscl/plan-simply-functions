import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as plan_model from "./plan_model";
import * as view_model from "./view_model";
import * as driver_model from "./driver_model";
import * as utils from "./utils";
import * as entity_model from "./entity_model";
import * as driver_calc from "./driver_calc";

interface batchCounter {
  total_pending: number;
}

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

interface contextParams {
  entityId: string;
  versionId: string;
  planId: string;
}

const db = admin.firestore();

export const planVersionRecalc = functions
  .runWith({ maxInstances: 1 })
  .firestore.document("entities/{entityId}/plans/{planId}/versions/{versionId}/dept/{acctId}")
  .onUpdate(async (snapshot, context) => {
    try {
      const nlevel_acct_before = snapshot.before.data() as plan_model.accountDoc;
      let nlevel_acct_after = snapshot.after.data() as plan_model.accountDoc;
      const context_params = {
        entityId: context.params.entityId,
        planId: context.params.planId,
        versionId: context.params.versionId,
      };

      // read the document again and print values from all updates
      const nlevel_snap = await snapshot.after.ref.get();
      if (!nlevel_snap.exists) throw new Error("Could not read updated document snapshot");

      // console.log(`BEFORE Snapshot: ${JSON.stringify(nlevel_acct_before)}`);
      // console.log(`AFTER Snapshot: ${JSON.stringify(nlevel_acct_after)}`);
      // console.log(`NOW Snapshot: ${JSON.stringify(nlevel_snap.data() as plan_model.accountDoc)}`);

      // run with CURRENT SNAPSHOT ...
      nlevel_acct_after = nlevel_snap.data() as plan_model.accountDoc;

      // EXIT IF THIS IS AN INITIAL PLAN CALCULATION or rollup account level!
      if ((nlevel_acct_after.parent_rollup !== undefined && nlevel_acct_before.parent_rollup === undefined) || nlevel_acct_after.class === "rollup") {
        return;
      }

      // initialize variables for tracking changes in monthly data
      const diffByMonth: number[] = [];
      const months_changed: number[] = [];
      let diffTotal = 0;

      // calculate difference for each month and track which months changed
      // currently changes are triggered for each single change, but this is designed to handle multiple changes in the future
      for (let periodIdx = 0; periodIdx < nlevel_acct_before.values.length; periodIdx++) {
        diffByMonth[periodIdx] = nlevel_acct_after.values[periodIdx] - nlevel_acct_before.values[periodIdx];
        if (diffByMonth[periodIdx] !== 0) {
          months_changed.push(periodIdx);
          diffTotal += diffByMonth[periodIdx];
        }
      }

      const acct_changes: acctChanges = {
        diffByMonth: diffByMonth,
        diffTotal: diffTotal,
        months_changed: months_changed,
        operation: 1,
      };

      // if there is no change across all 12 months, exit => this is important to avoid endless update triggers!!
      if (months_changed.length === 0) {
        return;
      }

      // update the total in the after account object
      nlevel_acct_after.total += diffTotal;

      // call update to rollup entity, if any
      await updateAccountInRollupEntities(context_params, nlevel_acct_after, acct_changes);

      // create a new batch and add n-level account changes
      let acct_update_batch = db.batch();
      acct_update_batch.update(snapshot.after.ref, {
        total: nlevel_acct_after.total,
      });
      const batch_counter = { total_pending: 1 };

      // save account reference
      let currChildAcct: plan_model.accountDoc | undefined = nlevel_acct_after;

      // IF THERE IS NO PARENT ROLLUP, WE HAVE REACHED THE TOP LEVEL => END FUNCTION
      while (currChildAcct !== undefined && currChildAcct.parent_rollup !== undefined) {
        currChildAcct = await updateParentAccounts(currChildAcct, acct_changes, acct_update_batch, batch_counter, context_params);
        // intermittent write if the batch reaches 400
        if (batch_counter.total_pending > 400) {
          batch_counter.total_pending = 0;
          await acct_update_batch.commit();
          acct_update_batch = db.batch();
        }
      }

      // final commit of any remaining items in the batch
      if (batch_counter.total_pending > 0) {
        await acct_update_batch.commit();
      }

      // TODO: make sure any accounts dependent on this driver will be recalculated as well.
      await recalcDependentDrivers(context_params.entityId, context_params.planId, context_params.versionId, nlevel_acct_after.full_account);
    } catch (error) {
      console.log("Error occured during calculation of plan version: " + error);
      return;
    }
  });

async function updateParentAccounts(
  childAccount: plan_model.accountDoc,
  acct_changes: acctChanges,
  update_batch: FirebaseFirestore.WriteBatch,
  batch_counter: batchCounter,
  context_params: contextParams
): Promise<plan_model.accountDoc | undefined> {
  const parent_accounts: parentAccounts[] = [];

  if (childAccount.parent_rollup !== undefined && childAccount.dept !== undefined) {
    // add dept rollup to list
    const dept_rollup_acctId = childAccount.full_account.replace(childAccount.acct, childAccount.parent_rollup.acct);
    parent_accounts.push({ type: "dept", acct_id: dept_rollup_acctId });

    // add div rollup to list
    const div_rollfup_acctId = dept_rollup_acctId.replace(`.${childAccount.dept}`, "");
    parent_accounts.push({ type: "div", acct_id: div_rollfup_acctId });

    let ret_acct_obj = undefined;

    acct_changes.operation *= childAccount.parent_rollup.operation;

    // loop through the parent acocunts (div & dept)
    for (const parent_acct of parent_accounts) {
      const acct_snap = await db
        .collection(`entities/${context_params.entityId}/plans/${context_params.planId}/versions`)
        .doc(`${context_params.versionId}/${parent_acct.type}/${parent_acct.acct_id}`)
        .get();
      if (!acct_snap.exists) continue;

      const acct_obj = acct_snap.data() as plan_model.accountDoc;

      // calculate the values
      calcAccountValues(acct_changes, acct_obj, 1);

      // add to batch and increase counter
      update_batch.update(acct_snap.ref, {
        total: acct_obj.total,
        values: acct_obj.values,
      });
      batch_counter.total_pending++;

      if (parent_acct.type === "dept") {
        // save for returning if dept
        ret_acct_obj = acct_obj;
        // also try to find group accounts and process those
        await updateGroupAccounts(context_params, parent_acct.acct_id, update_batch, batch_counter, acct_changes);
        // also process P&L accounts
        await updatePnlAggregates(context_params, parent_acct.acct_id, update_batch, batch_counter, acct_changes);
      } else if (parent_acct.type === "div") {
        // also process P&L accounts
        await updatePnlAggregates(context_params, parent_acct.acct_id, update_batch, batch_counter, acct_changes);
      }
    }

    // all done => return the DEPT level account as the new child
    return ret_acct_obj;
  } else {
    return undefined;
  }
}

function calcAccountValues(acct_changes: acctChanges, acct_obj: plan_model.accountDoc | view_model.pnlAggregateDoc, pnl_ops: number) {
  for (const idxPeriod of acct_changes.months_changed) {
    acct_obj.values[idxPeriod] += acct_changes.diffByMonth[idxPeriod] * acct_changes.operation * pnl_ops;
  }
  acct_obj.total += acct_changes.diffTotal * acct_changes.operation * pnl_ops;
}

async function updateGroupAccounts(
  context_params: contextParams,
  group_child_acct: string,
  update_batch: FirebaseFirestore.WriteBatch,
  batch_counter: batchCounter,
  acct_changes: acctChanges
) {
  // find any group accounts that contain the parent account
  const group_parents_snap = await db
    .collection(`entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/dept`)
    .where("group_children", "array-contains", group_child_acct)
    .get();

  for (const group_parent_doc of group_parents_snap.docs) {
    const acct_obj = group_parent_doc.data() as plan_model.accountDoc;

    // calculate the values
    calcAccountValues(acct_changes, acct_obj, 1);
    // add to batch and increase counter
    update_batch.update(group_parent_doc.ref, {
      total: acct_obj.total,
      values: acct_obj.values,
    });
    batch_counter.total_pending++;
  }
}

async function updatePnlAggregates(
  context_params: contextParams,
  div_account_id: string,
  update_batch: FirebaseFirestore.WriteBatch,
  batch_counter: batchCounter,
  acct_changes: acctChanges
) {
  const pnl_agg_snap = await db
    .collection(`entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/pnl`)
    .where("child_accts", "array-contains", div_account_id)
    .get();

  for (const pnl_doc of pnl_agg_snap.docs) {
    const pnl_obj = pnl_doc.data() as view_model.pnlAggregateDoc;

    // calculate the values
    calcAccountValues(acct_changes, pnl_obj, pnl_obj.child_ops[pnl_obj.child_accts.indexOf(div_account_id)]);

    // add to batch and increase counter
    update_batch.update(pnl_doc.ref, {
      total: pnl_obj.total,
      values: pnl_obj.values,
    });
    batch_counter.total_pending++;
  }
}

async function updateAccountInRollupEntities(context_params: contextParams, nlevel_acct_after: plan_model.accountDoc, acct_changes: acctChanges) {
  // console.log(`Updating account in rollup entity if needed`);
  // get the entity doc of the one that was changed initially
  const entity_snap = await db.doc(`entities/${context_params.entityId}`).get();
  if (!entity_snap.exists) throw new Error("could not find entity document of the entity where the account was updated >> Fatal error.");
  const entity_obj = entity_snap.data() as entity_model.entityDoc;

  // Find rollup entities for this entity
  const rollup_ent_snaps = await db
    .collection(`entities`)
    .where("type", "==", "rollup")
    .where("children", "array-contains", context_params.entityId)
    .get();

  // ... & loop through all of them
  for (const rollup_entity_doc of rollup_ent_snaps.docs) {
    const rollup_entity = rollup_entity_doc.data() as entity_model.entityDoc;
    const rollup_plan_snaps = await rollup_entity_doc.ref.collection("plans").get();

    for (const rollup_plan_doc of rollup_plan_snaps.docs) {
      const rollup_version_snaps = await rollup_plan_doc.ref
        .collection("versions")
        .where("child_version_ids", "array-contains", context_params.versionId)
        .get();

      for (const rollup_version_doc of rollup_version_snaps.docs) {
        // console.log(
        //   `found matching parent version for child version: ${context_params.versionId}`
        // );
        const acct_cmpnts = utils.extractComponentsFromFullAccountString(nlevel_acct_after.full_account, [entity_obj.full_account]);

        // add values to it (pass in changes from main function)
        // save account
        // console.log(
        //   `extracted account components from full account: ${JSON.stringify(
        //     acct_cmpnts
        //   )}`
        // );

        if (nlevel_acct_after.dept === undefined)
          throw new Error(`Dept not defined for account ${nlevel_acct_after.full_account} in version ${context_params.versionId}`);

        // convert the dept string to replace the entity => IMPORTANT: update the utils to evaluate the embeds array for undefined and the field!!
        const rollup_dept_id = utils.substituteEntityForRollup(nlevel_acct_after.dept, rollup_entity.entity_embeds, rollup_entity.number);
        // console.log(
        //   `converted dept_id from ${nlevel_acct_after.dept} to ${rollup_dept_id}`
        // );

        // create a new full account string
        const rollup_full_account = utils.buildFullAccountString([rollup_entity.full_account], { ...acct_cmpnts, dept: rollup_dept_id });

        // query the account from the rollup entity
        const rollup_acct_snap = await rollup_version_doc.ref.collection("dept").doc(rollup_full_account).get();

        if (!rollup_acct_snap.exists) {
          console.log(`Account ${rollup_full_account} not found in version ${rollup_version_doc.id} for entity ${rollup_entity_doc.id}`);
          continue;
        }

        const rollup_account = rollup_acct_snap.data() as plan_model.accountDoc;

        // account found, do the math
        // console.log(
        //   `Account found in version ${rollup_version_doc.id} for entity ${
        //     rollup_entity_doc.id
        //   }: ${JSON.stringify(rollup_account)}`
        // );

        //rollup_account.total += acct_changes.diffTotal;
        for (const idx of acct_changes.months_changed) {
          rollup_account.values[idx] += acct_changes.diffByMonth[idx];
        }

        // updated account
        // console.log(
        //   `updated rollup account, to be saved back: ${JSON.stringify(
        //     rollup_account
        //   )}`
        // );

        await rollup_acct_snap.ref.update({ values: rollup_account.values });
      }
    }
  }
}

async function recalcDependentDrivers(entity_id: string, plan_id: string, version_id: string, ref_acct_id: string) {
  const driver_acct_snap = await db.collection(`entities/${entity_id}/drivers/${version_id}/dept`).where("ref_accts", "array-contains", ref_acct_id).get();
  if (driver_acct_snap.empty) return;

  // loop through driver accounts and trigger a recalc for each
  for (const driver_doc of driver_acct_snap.docs) {
    const driver_def = driver_doc.data() as driver_model.acctDriverDef;

    await driver_calc.driverCalcValue(driver_def, { acct_id: driver_doc.id, entity_id: entity_id, plan_id: plan_id, version_id: version_id });
  }
}
