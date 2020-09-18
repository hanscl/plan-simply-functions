import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

interface batchCounter {
  total_pending: number;
}

interface parentRollup {
  acct: string;
  operation: number;
}

interface accountDoc {
  acct: string;
  acct_name: string;
  acct_type?: string;
  class: string;
  dept?: string;
  div: string;
  divdept_name: string;
  group: boolean;
  full_account: string;
  parent_rollup?: parentRollup;
  total: number;
  values: number[];
  group_children?: string[];
  is_group_child: boolean;
}
interface pnlAggregateDoc {
  child_accts: string[];
  child_ops: number[];
  total: number;
  values: number[];
  view_id: string;
}

interface parentAccounts {
  type: "dept" | "div";
  acct_id: string;
  acct_obj?: accountDoc;
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

export const planVersionRecalc = functions.firestore
  .document("entities/GEAMS/plans/{planId}/versions/{versionId}/dept/{acctId}") // TODO CHANGE
  .onUpdate(async (snapshot, context) => {
    try {
      const nlevel_acct_before = snapshot.before.data() as accountDoc;
      const nlevel_acct_after = snapshot.after.data() as accountDoc;
      const context_params = {
        entityId: "GEAMS", //TODO: REMOVE when done with GEAMS testing
        planId: context.params.planId,
        versionId: context.params.versionId,
      };

      // EXIT IF THIS IS AN INITIAL PLAN CALCULATION or rollup account level!
      if (
        (nlevel_acct_after.parent_rollup !== undefined &&
          nlevel_acct_before.parent_rollup === undefined) ||
        nlevel_acct_after.class === "rollup"
      ) {
        return;
      }

      // initialize variables for tracking changes in monthly data
      const diffByMonth: number[] = [];
      const months_changed: number[] = [];
      let diffTotal = 0;

      // calculate difference for each month and track which months changed
      // currently changes are triggered for each single change, but this is designed to handle multiple changes in the future
      for (
        let periodIdx = 0;
        periodIdx < nlevel_acct_before.values.length;
        periodIdx++
      ) {
        diffByMonth[periodIdx] =
          nlevel_acct_after.values[periodIdx] -
          nlevel_acct_before.values[periodIdx];
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
      nlevel_acct_after.total += +diffTotal;

      // create a new batch and add n-level account changes
      let acct_update_batch = db.batch();
      acct_update_batch.update(snapshot.after.ref, {
        total: nlevel_acct_after.total,
      });
      const batch_counter = { total_pending: 1 };

      // save account reference
      let currChildAcct: accountDoc | undefined = nlevel_acct_after;

      // IF THERE IS NO PARENT ROLLUP, WE HAVE REACHED THE TOP LEVEL => END FUNCTION
      while (
        currChildAcct !== undefined &&
        currChildAcct.parent_rollup !== undefined
      ) {
        currChildAcct = await updateParentAccounts(
          currChildAcct,
          acct_changes,
          acct_update_batch,
          batch_counter,
          context_params
        );
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
    } catch (error) {
      console.log("Error occured during calculation of plan version: " + error);
      return;
    }
  });

async function updateParentAccounts(
  childAccount: accountDoc,
  acct_changes: acctChanges,
  update_batch: FirebaseFirestore.WriteBatch,
  batch_counter: batchCounter,
  context_params: contextParams
): Promise<accountDoc | undefined> {
  const parent_accounts: parentAccounts[] = [];

  if (
    childAccount.parent_rollup !== undefined &&
    childAccount.dept !== undefined
  ) {
    // add dept rollup to list
    const dept_rollup_acctId = childAccount.full_account.replace(
      childAccount.acct,
      childAccount.parent_rollup.acct
    );
    parent_accounts.push({ type: "dept", acct_id: dept_rollup_acctId });

    // add div rollup to list
    const div_rollfup_acctId = dept_rollup_acctId.replace(
      `.${childAccount.dept}`,
      ""
    );
    parent_accounts.push({ type: "div", acct_id: div_rollfup_acctId });

    let ret_acct_obj = undefined;

    acct_changes.operation *= childAccount.parent_rollup.operation;

    // loop through the parent acocunts (div & dept)
    for (const parent_acct of parent_accounts) {
      const acct_snap = await db
        .collection(
          `entities/${context_params.entityId}/plans/${context_params.planId}/versions`
        )
        .doc(
          `${context_params.versionId}/${parent_acct.type}/${parent_acct.acct_id}`
        )
        .get();
      if (!acct_snap.exists) continue;

      const acct_obj = acct_snap.data() as accountDoc;

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
        await updateGroupAccounts(
          context_params,
          parent_acct.acct_id,
          update_batch,
          batch_counter,
          acct_changes
        );
      } else if (parent_acct.type === "div") {
        // also process P&L accounts
        await updatePnlAggregates(
          context_params,
          parent_acct.acct_id,
          update_batch,
          batch_counter,
          acct_changes
        );
      }
    }

    // all done => return the DEPT level account as the new child
    return ret_acct_obj;
  } else {
    return undefined;
  }
}

function calcAccountValues(
  acct_changes: acctChanges,
  acct_obj: accountDoc | pnlAggregateDoc,
  pnl_ops: number
) {
  for (const idxPeriod of acct_changes.months_changed) {
    acct_obj.values[idxPeriod] +=
      acct_changes.diffByMonth[idxPeriod] * acct_changes.operation * pnl_ops;
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
  .collection(
    `entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/dept`
  )
  .where("group_children", "array-contains", group_child_acct)
  .get();
   
  for (const group_parent_doc of group_parents_snap.docs) {
    const acct_obj = group_parent_doc.data() as accountDoc;

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
   .collection(
      `entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/pnl`
    )
    .where("child_accts", "array-contains",  div_account_id)
    .get();

  for (const pnl_doc of pnl_agg_snap.docs) {
    const pnl_obj = pnl_doc.data() as pnlAggregateDoc;
  
    // calculate the values
    calcAccountValues(
      acct_changes,
      pnl_obj,
      pnl_obj.child_ops[pnl_obj.child_accts.indexOf(div_account_id)]
    );

    // add to batch and increase counter
    update_batch.update(pnl_doc.ref, {
      total: pnl_obj.total,
      values: pnl_obj.values,
    });
    batch_counter.total_pending++;
  }
}