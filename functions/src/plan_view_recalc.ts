import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as viewModel from "./model_view";
import * as acctModel from "./model_acct";

interface batchCounter {
  total_pending: number;
}

interface parentAccounts {
  type: string;
  acct_id: string;
  acct_obj?: acctModel.accountDoc;
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

export const planViewReCalc = functions.firestore
  .document(
    "entities/{entityId}/plans/{planId}/versions/{versionId}/dept/{acctId}"
  )
  .onUpdate(async (snapshot, context) => {
    try {
      const nlevel_acct_before = snapshot.before.data() as acctModel.accountDoc;
      const nlevel_acct_after = snapshot.after.data() as acctModel.accountDoc;
      const context_params = {
        entityId: context.params.entityId,
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

      // Update the view lines that contain this account
      await updateViews(
        nlevel_acct_after,
        context_params,
        acct_update_batch,
        batch_counter,
        false
      );

      // save account reference
      let currChildAcct: acctModel.accountDoc | undefined = nlevel_acct_after;

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
        console.log(
          "final commit - writing " +
            batch_counter.total_pending +
            " total docs"
        );
        await acct_update_batch.commit();
      }
    } catch (error) {
      console.log("Error occured during creation of new plan view: " + error);
      return;
    }
  });

async function updateParentAccounts(
  childAccount: acctModel.accountDoc,
  acct_changes: acctChanges,
  update_batch: FirebaseFirestore.WriteBatch,
  batch_counter: batchCounter,
  context_params: contextParams
): Promise<acctModel.accountDoc | undefined> {
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

      const acct_obj = acct_snap.data() as acctModel.accountDoc;

      // save for returning if dept
      if (parent_acct.type === "dept") {
        ret_acct_obj = acct_obj;
      }

      for (const idxPeriod of acct_changes.months_changed) {
        acct_obj.values[idxPeriod] +=
          acct_changes.diffByMonth[idxPeriod] * acct_changes.operation;
      }
      acct_obj.total += acct_changes.diffTotal * acct_changes.operation;

      // add to batch and increase counter
      update_batch.update(acct_snap.ref, {
        total: acct_obj.total,
        values: acct_obj.values,
      });
      batch_counter.total_pending++;

      // update the corresponding views as well
      await updateViews(
        acct_obj,
        context_params,
        update_batch,
        batch_counter,
        true
      );
    }

    // all done => return the DEPT level account as the new child
    return ret_acct_obj;
  } else {
    return undefined;
  }
}

async function updateViews(
  account: acctModel.accountDoc,
  context_params: contextParams,
  update_batch: FirebaseFirestore.WriteBatch,
  batch_counter: batchCounter,
  sections: boolean
) {
  try {
    console.log("updating views for: " + account.full_account);
    const view_snapshots = await db
      .collection(`entities/${context_params.entityId}/views`)
      .where("plan_id", "==", context_params.planId)
      .where("version_id", "==", context_params.versionId)
      .get();

    for (const view_doc of view_snapshots.docs) {
      console.log("updating view: " + view_doc.id);
      await updateViewLines(
        account,
        context_params,
        update_batch,
        batch_counter,
        view_doc
      );
      if (sections) {
        await updateViewSections(
          account,
          context_params,
          update_batch,
          batch_counter,
          view_doc
        );
      }
    }
  } catch (error) {
    console.log("Error occured while updating views: " + error);
    return;
  }
}

async function updateViewLines(
  account: acctModel.accountDoc,
  context_params: contextParams,
  update_batch: FirebaseFirestore.WriteBatch,
  batch_counter: batchCounter,
  view_doc: FirebaseFirestore.QueryDocumentSnapshot<
    FirebaseFirestore.DocumentData
  >
) {
  try {
    console.log("updating view lines");
    const line_snapshots = await view_doc.ref
      .collection("lines")
      .where("full_account", "==", account.full_account)
      .get();

    for (const line_doc of line_snapshots.docs) {
      console.log("updating line: " + line_doc.id);
      update_batch.update(line_doc.ref, {
        total: account.total,
        values: account.values,
      });
      batch_counter.total_pending++;
    }
    return;
  } catch (error) {
    console.log("Error occured while updating views lines " + error);
    return;
  }
}

async function updateViewSections(
  account: acctModel.accountDoc,
  context_params: contextParams,
  update_batch: FirebaseFirestore.WriteBatch,
  batch_counter: batchCounter,
  view_doc: FirebaseFirestore.QueryDocumentSnapshot<
    FirebaseFirestore.DocumentData
  >
) {
  try {
    console.log("updating sections.");
    console.log("view_doc.ref: " + view_doc.ref);
    const sections_snapshots = await view_doc.ref
      .collection("sections")
      .where("accts.acct_ids", "array-contains", account.full_account)
      .get();

    for (const section_doc of sections_snapshots.docs) {
      console.log("updating section: " + section_doc.id);
      const section_data = section_doc.data() as viewModel.sectionDoc;
      console.log("section_data:" + JSON.stringify(section_data));
      const acct_idx = section_data.accts.acct_ids.indexOf(account.full_account);
      console.log("acct_idx: " + acct_idx);
      console.log('account: ' + JSON.stringify(account));
      // (B-1) UPDATE total/total and total/values of section
      section_data.total.total +=
        (account.total - section_data.accts.acct_data[acct_idx].total) *
        section_data.accts.acct_data[acct_idx].operation;

      for (let idxPeriod = 0; idxPeriod < account.values.length; idxPeriod++) {
        section_data.total.values[idxPeriod] +=
          (account.values[idxPeriod] -
            section_data.accts.acct_data[acct_idx].values[idxPeriod]) *
          section_data.accts.acct_data[acct_idx].operation;
      }

      // (B-2) UPDATE totals/values of the child acct in the section
      section_data.accts.acct_data[acct_idx].total = account.total;
      section_data.accts.acct_data[acct_idx].values = account.values;

      // (B-3) WRITE CHANGES TO DATABASE
      update_batch.update(section_doc.ref, section_data);
      batch_counter.total_pending++;
    }
    return;
  } catch (error) {
    console.log("Error occured while updating views sections " + error);
    return;
  }
}
