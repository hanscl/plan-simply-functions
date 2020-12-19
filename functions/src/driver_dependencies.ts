import * as admin from "firebase-admin";
import * as driver_model from "./driver_model";
import * as entity_model from "./entity_model";
import * as view_model from "./view_model";
import * as utils from "./utils";

const db = admin.firestore();

export async function driverDependencyBuild(
  context_params: driver_model.driverParamsAll,
  driver_lst: driver_model.driverEntry[],
  driver_params: driver_model.driverParamsAll
) {
  try {
    /*** 1. LOAD ENTITY STRUCTURE AND PLAN DOCUMENTS */

    // load the entity structure and plan docs
    const entity_doc_snap = await db.doc(`entities/${context_params.entity_id}`).get();
    const acct_doc_snap = await entity_doc_snap.ref.collection("entity_structure").doc("acct").get();
    const div_doc_snap = await entity_doc_snap.ref.collection("entity_structure").doc("div").get();
    const plan_doc_snap = await entity_doc_snap.ref.collection("plans").doc(context_params.plan_id).get();

    if (!entity_doc_snap.exists || !acct_doc_snap.exists || !div_doc_snap.exists || !plan_doc_snap.exists)
      throw new Error(`Entity structure documents and/or plan document not found for ${context_params.entity_id}`);

    // get the data from all the documents
    const entity = entity_doc_snap.data() as entity_model.entityDoc;
    const acct_dict = acct_doc_snap.data() as entity_model.acctDict;
    const div_dict = div_doc_snap.data() as entity_model.divDict;

    // rollup and group document path
    const rollup_doc_path = `entities/${context_params.entity_id}/entity_structure/rollup`;
    const rollup_coll_snap = await db.collection(`${rollup_doc_path}/rollups`).get();
    const rollups: entity_model.EntityRollupDocument[] = [];
    rollup_coll_snap.forEach((rollup_doc) => {
      rollups.push(rollup_doc.data() as entity_model.EntityRollupDocument);
    });

    // load groups
    const group_snap = await db.doc(`entities/${context_params.entity_id}/entity_structure/group`).get();
    const groups: entity_model.groupObj[] = [];
    if (group_snap.exists) {
      (group_snap.data() as entity_model.groupDoc).groups.forEach((group_obj) => {
        groups.push(group_obj);
      });
    }

    // load driver account ids
    // const all_driver_accts: string[] = [];
    // const driver_acct_snap = await entity_doc_snap.ref.collection("drivers").doc(driver_params.version_id).collection("dept").get();
    // for (const drv_acct of driver_acct_snap.docs) {
    //   all_driver_accts.push(drv_acct.id);
    // }

    /***** 2. PROCEED WITH DEPENDENCY BUILD *****/

    // remove static driver values from list so we only have accounts
    const driver_accts: driver_model.driverEntry[] = driver_lst.filter((driver_entry) => {
      return driver_entry.type === "acct";
    });

    const acct_list: string[] = [];
    for (const drv_acct of driver_accts) {
      const drv_entry = drv_acct.entry as driver_model.driverAcct;
      // resolve pnl entries to its children first and push the children instead of the id
      if (drv_entry.level === "pnl") {
        const pnl_doc = await plan_doc_snap.ref.collection("versions").doc(driver_params.version_id).collection("pnl").doc(drv_entry.id).get();
        if (!pnl_doc.exists) {
          console.log(`Unable to resolve PNL document from driver`);
          continue;
        }
        const pnl_obj = pnl_doc.data() as view_model.pnlAggregateDoc;
        console.log(`P&L Object: ${JSON.stringify(pnl_obj)}`);
        for (const child_acct of pnl_obj.child_accts) {
          acct_list.push(child_acct);
        }
      } else acct_list.push(drv_entry.id);
    }

    console.log(`acct_list: ${JSON.stringify(acct_list)}`);

    // Recursive function to resolve all rollups
    return await resolveRollups(acct_list, entity, rollups, div_dict, acct_dict, groups); 
  } catch (error) {
    console.log("Error occured during driver dependency build: " + error);
    return;
  }
}

/***** HELPER FUNCTION TO CHECK IF ACCOUNT IS A ROLLUP */
function acctIsRollup(driver_account: string, entity: entity_model.entityDoc, rollups: entity_model.EntityRollupDocument[]): boolean {
  // console.log(`calling UTILS.exctratComp with ${JSON.stringify(driver_account)} & ${entity.full_account} ${entity.div_account}`);
  const acct = utils.extractAcctFromFullAccount(driver_account, [entity.full_account, entity.div_account], "acct");

  const rollup_idx = rollups.findIndex((rollup_obj) => {
    return rollup_obj.rollup === acct;
  });
  if (rollup_idx !== -1) {
    return true;
  }

  return false;
}

/***** GET THE CHILDREN OF THE CURRENT ROLLUP */
function getRollupChildren(
  driver_account: string,
  entity: entity_model.entityDoc,
  div_dict: entity_model.divDict,
  groups: entity_model.groupObj[],
  rollups: entity_model.EntityRollupDocument[],
  acct_dict: entity_model.acctDict
) {
  // Extract the acct elements
  const acct_format_strings = [entity.full_account];
  if (entity.div_account !== undefined) acct_format_strings.push(entity.div_account);
  // console.log(`calling UTILS.exctratComp with ${JSON.stringify(driver_account)} & ${acct_format_strings}`);
  const acct_components = utils.extractComponentsFromFullAccountString(driver_account, acct_format_strings);

  // make sure we have dept and acct ids
  if (acct_components.acct === "" || acct_components.div === "") throw new Error("Unable to find div or acct id");

  // build full string WITHOUT dept
  const full_acct_no_dept = entity.full_account.replace("@acct@", acct_components.acct).replace("@div@", acct_components.div);

  const ret_acct_list: string[] = [];

  // 1. DIV => go to DEPTS
  if (acct_components.dept === undefined) {
    for (const add_dept_id of div_dict[acct_components.div].depts) {
      ret_acct_list.push(full_acct_no_dept.replace("@dept@", add_dept_id));
    }
    return ret_acct_list;
  }

  // 2. GROUP => Go to GROUP CHILDREN (DEPTS)
  const group_items = groups.filter((group_obj) => {
    return group_obj.code === acct_components.dept;
  });
  if (group_items.length > 0) {
    for (const grp_child of group_items[0].children) {
      ret_acct_list.push(full_acct_no_dept.replace("@dept@", grp_child));
    }
    return ret_acct_list;
  }

  // 3. It's not a GROUP or DIV, so now we roll down the ACCT LEVEL
  const full_acct_no_acct = entity.full_account.replace("@dept@", acct_components.dept).replace("@div@", acct_components.div);
  const rollup_items = rollups.filter((rollup_obj) => {
    return rollup_obj.rollup === acct_components.acct;
  });
  if (rollup_items.length > 0) {
    // More rollups?
    if (rollup_items[0].child_rollups !== undefined) {
      for (const rollup_id of Object.keys(rollup_items[0].child_rollups)) {
        ret_acct_list.push(full_acct_no_acct.replace("@acct@", rollup_id));
      }
      // found rollups, we can return now
      return ret_acct_list;
    }

    // If we get here, the rollup does not have further rollup children, we need to find
    // n-level accounts to return
    const acct_list = Object.entries(acct_dict).filter(([item_acct_id, acct_map]) => acct_map.type === acct_components.acct);
    for (const acct_item of acct_list) {
      if (!acct_dict[acct_item[0]].depts.includes(acct_components.dept)) continue;

      const upd_acct = full_acct_no_acct.replace("@acct@", acct_item[0]);
      ret_acct_list.push(upd_acct);
    }
    return ret_acct_list;
  }

  console.log("Unable to find children for rollup -- this should not happen but is not fatal.");
  return [];
}

/***** RESOLVE ROLLUPS - RECURSIVELY CALLED. CHECKS IF AN ACCOUNT IS A ROLLUP AND PROCEEDS ACCORDINGLY */
async function resolveRollups(
  acct_lst: string[],
  entity: entity_model.entityDoc,
  rollups: entity_model.EntityRollupDocument[],
  div_dict: entity_model.divDict,
  acct_dict: entity_model.acctDict,
  groups: entity_model.groupObj[]
): Promise<string[]> {
  let acct_lst_copy = acct_lst;
  for (let idx = acct_lst_copy.length - 1; idx >= 0; idx--) {
    if (acctIsRollup(acct_lst_copy[idx], entity, rollups)) {
      acct_lst_copy = acct_lst_copy
        .slice(0, idx)
        .concat(
          await resolveRollups(
            getRollupChildren(acct_lst_copy[idx], entity, div_dict, groups, rollups, acct_dict),
            entity,
            rollups,
            div_dict,
            acct_dict,
            groups
          ),
          acct_lst_copy.slice(idx + 1)
        );
    }
  }
  return [...new Set(acct_lst_copy)];
}
