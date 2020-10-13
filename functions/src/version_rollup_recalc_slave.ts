import * as admin from "firebase-admin";
import * as plan_model from "./plan_model";
import * as utils from "./utils";
import * as view_model from "./view_model";

const db = admin.firestore();

interface recalcParams {
  entity_id: string;
  plan_id: string;
  version_id: string;
  acct_id: string;
  values: number[];
  dept?: string;
}

interface docRefs {
  entity: FirebaseFirestore.DocumentReference;
  plan: FirebaseFirestore.DocumentReference;
  version: FirebaseFirestore.DocumentReference;
  acct: FirebaseFirestore.DocumentReference;
}

interface parentAccounts {
  type: "dept" | "div";
  acct_id: string;
  acct_obj?: plan_model.accountDoc;
}

export interface acctChanges {
  diff_by_month: number[];
  diff_total: number;
  months_changed: number[];
  operation: number;
}

interface updateObj {
  doc_ref: FirebaseFirestore.DocumentReference;
  values: number[];
  total: number;
}

export async function executeVersionRollupRecalc(recalc_params: recalcParams, recalc_tx: FirebaseFirestore.Transaction, caller_id: "entry" | "driver" | "labor" | "entity_rollup" = "entry", passed_acct_changes?: acctChanges) {
  try {
    // get the version, plan and account references
    const entity_ref = db.doc(`entities/${recalc_params.entity_id}`);
    const plan_ref = entity_ref.collection("plans").doc(recalc_params.plan_id);
    const version_ref = plan_ref.collection("versions").doc(recalc_params.version_id);
    const acct_ref = version_ref.collection("dept").doc(recalc_params.acct_id);
    const doc_refs: docRefs = { entity: entity_ref, plan: plan_ref, version: version_ref, acct: acct_ref };

    // ... and the account document
    const curr_acct_doc = await recalc_tx.get(doc_refs.acct);
    const nlevel_acct_before = curr_acct_doc.data() as plan_model.accountDoc;

    console.log(`Retrieved previous account: ${JSON.stringify(nlevel_acct_before)}. Updating values to: ${JSON.stringify(recalc_params.values)}`);

    // Do not calculate stats
    if (nlevel_acct_before.acct_type === "STATS") return undefined;

    let acct_changes = passed_acct_changes;
    if (acct_changes === undefined) {
      // create object to track changes and get changes from utils module => throw error if difference cannot be calculated
      acct_changes = {
        diff_by_month: utils.getValuesArray(),
        diff_total: 0,
        months_changed: [],
        operation: 1,
      };
      const utils_ret = utils.getValueDiffsByMonth(
        nlevel_acct_before.values,
        recalc_params.values,
        acct_changes.diff_by_month,
        acct_changes.months_changed
      );
      if (utils_ret === undefined) throw new Error(`Utils.getValueDiffsByMonth returned undefined. Aborting versionRollupRecalc`);
      acct_changes.diff_total = utils_ret;
    }
    else {
      // set the recalc params to the new value 
      recalc_params.values = utils.addValuesByMonth(nlevel_acct_before.values,  acct_changes.diff_by_month); 
      // reset operation to 1
      acct_changes.operation = 1;
    }

    console.log(`utils calculated differences: ${JSON.stringify(acct_changes)}`);

    // if there is no change across all 12 months, exit => this is important to avoid endless update triggers!!
    if (acct_changes.months_changed.length === 0) return undefined;

    // create a copy of the account, with new values & update the params object with the dept
    const nlevel_acct_after = { ...nlevel_acct_before, values: recalc_params.values, calc_type: caller_id };
    nlevel_acct_after.total += acct_changes.diff_total;
    recalc_params.dept = nlevel_acct_after.dept;

    console.log(`Updating nlevel account object to: ${JSON.stringify(nlevel_acct_after)}`);

    // save account reference & initialize update collection
    let currChildAcct: plan_model.accountDoc | undefined = nlevel_acct_after;
    const update_collection: updateObj[] = [];

    // IF THERE IS NO PARENT ROLLUP, WE HAVE REACHED THE TOP LEVEL => END FUNCTION
    while (currChildAcct !== undefined && currChildAcct.parent_rollup !== undefined) {
      // console.log(`Calling update parent accounts for the ${++ctr}th time. Acct: ${JSON.stringify(currChildAcct)}`);
      currChildAcct = await updateParentAccounts(recalc_tx, doc_refs, currChildAcct, acct_changes, recalc_params, update_collection);
    }

    console.log(`loop is done. Update array is: ${JSON.stringify(update_collection)}`);

    // Add updates to transaction
    for (const update_obj of update_collection) {
      recalc_tx.update(update_obj.doc_ref, { total: update_obj.total, values: update_obj.values });
    }

    // write the n_level account changes
    recalc_tx.update(acct_ref, { values: nlevel_acct_after.values, total: nlevel_acct_after.total, calc_type: nlevel_acct_after.calc_type });

    return acct_changes;
  } catch (error) {
    throw new Error(`Failure inside transaction during executeVersionRollupCalc: ${error}`);
  }
}

async function updateParentAccounts(
  recalc_tx: FirebaseFirestore.Transaction,
  doc_refs: docRefs,
  childAccount: plan_model.accountDoc,
  acct_changes: acctChanges,
  recalc_params: recalcParams,
  update_collection: updateObj[]
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
      const acct_snap = await recalc_tx.get(
        doc_refs.plan.collection("versions").doc(`${recalc_params.version_id}/${parent_acct.type}/${parent_acct.acct_id}`)
      );
      if (!acct_snap.exists) continue;

      const acct_obj = acct_snap.data() as plan_model.accountDoc;

      // calculate the values
      calcAccountValues(acct_changes, acct_obj, 1);

      // add to update collection
      update_collection.push({ doc_ref: acct_snap.ref, total: acct_obj.total, values: acct_obj.values });

      if (parent_acct.type === "dept") {
        // save for returning if dept
        ret_acct_obj = acct_obj;
        // also try to find group accounts and process those

        await updateGroupAccounts(recalc_tx, recalc_params, doc_refs, parent_acct.acct_id, update_collection, acct_changes);
        // also process P&L accounts
        await updatePnlAggregates(recalc_tx, recalc_params, doc_refs, parent_acct.acct_id, update_collection, acct_changes);
      } else if (parent_acct.type === "div") {
        // also process P&L accounts
        await updatePnlAggregates(recalc_tx, recalc_params, doc_refs, parent_acct.acct_id, update_collection, acct_changes);
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
    acct_obj.values[idxPeriod] += acct_changes.diff_by_month[idxPeriod] * acct_changes.operation * pnl_ops;
  }
  acct_obj.total += acct_changes.diff_total * acct_changes.operation * pnl_ops;
}

async function updateGroupAccounts(
  recalc_tx: FirebaseFirestore.Transaction,
  recalc_params: recalcParams,
  doc_refs: docRefs,
  group_child_acct: string,
  update_collection: updateObj[],
  acct_changes: acctChanges
) {
  // find any group accounts that contain the parent account
  const group_parents_snap = await recalc_tx.get(doc_refs.version.collection("dept").where("group_children", "array-contains", group_child_acct));

  for (const group_parent_doc of group_parents_snap.docs) {
    const acct_obj = group_parent_doc.data() as plan_model.accountDoc;

    // calculate the values
    calcAccountValues(acct_changes, acct_obj, 1);

    // add update collection
    update_collection.push({ doc_ref: group_parent_doc.ref, total: acct_obj.total, values: acct_obj.values });
  }
}

async function updatePnlAggregates(
  recalc_tx: FirebaseFirestore.Transaction,
  recalc_params: recalcParams,
  doc_refs: docRefs,
  div_account_id: string,
  update_collection: updateObj[],
  acct_changes: acctChanges
) {
  const pnl_agg_snap = await recalc_tx.get(doc_refs.version.collection("pnl").where("child_accts", "array-contains", div_account_id));

  for (const pnl_doc of pnl_agg_snap.docs) {
    const pnl_obj = pnl_doc.data() as view_model.pnlAggregateDoc;

    // calculate the values
    calcAccountValues(acct_changes, pnl_obj, pnl_obj.child_ops[pnl_obj.child_accts.indexOf(div_account_id)]);

    // save to collection for update at the end
    update_collection.push({ doc_ref: pnl_doc.ref, total: pnl_obj.total, values: pnl_obj.values });
  }
}
