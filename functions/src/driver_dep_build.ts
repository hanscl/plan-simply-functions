import * as driver_model from "./driver_model";
import * as entity_model from "./entity_model";
import * as utils from "./utils";

export async function begin_dependency_build(
  db: FirebaseFirestore.Firestore,
  context_params: driver_model.contextParams,
  driver_lst: driver_model.driverEntry[]
) {
  try {
    // 1. LOAD ALL ENTITY STRUCTURE DOCS

    // load the entity structure items necessary to resolve rollups into accounts
    const entity_doc_snap = await db
      .doc(`entities/${context_params.entityId}`)
      .get();
    if (!entity_doc_snap.exists)
      throw new Error(`Entity doc not found for ${context_params.entityId}`);
    const entity = entity_doc_snap.data() as entity_model.entityDoc;

    // load the account structure
    const acct_doc_path = `entities/${context_params.entityId}/entity_structure/acct`;
    const acct_doc_snap = await db.doc(acct_doc_path).get();
    if (!acct_doc_snap.exists)
      throw new Error(`Acct defintions doc not found: ${acct_doc_path}`);
    const acct_dict = acct_doc_snap.data() as entity_model.acctDict;

    // load the div structure
    const div_doc_path = `entities/${context_params.entityId}/entity_structure/div`;
    const div_doc_snap = await db.doc(div_doc_path).get();
    if (!div_doc_snap.exists)
      throw new Error(`Div defintions doc not found: ${acct_doc_path}`);
    const div_dict = div_doc_snap.data() as entity_model.divDict;

    // load the plan doc (to get the rollup doc reference)
    const plan_doc_path = `entities/${context_params.entityId}/plans/${context_params.planId}`;
    const plan_doc_snap = await db.doc(plan_doc_path).get();
    if (!plan_doc_snap.exists)
      throw new Error(`Plan document not found: ${plan_doc_path}`);

    // rollup and group document path
    const rollup_doc_path = `entities/${context_params.entityId}/entity_structure/rollup`;
    // load rollups
    const rollup_coll_snap = await db
      .collection(`${rollup_doc_path}/rollups`)
      .get();
    const rollups: entity_model.rollupObj[] = [];
    rollup_coll_snap.forEach((rollup_doc) => {
      rollups.push(rollup_doc.data() as entity_model.rollupObj);
    });

    // load groups
    const group_snap = await db
      .doc(`entities/${context_params.entityId}/entity_structure/group`)
      .get();
    const groups: entity_model.groupObj[] = [];
    if (group_snap.exists) {
      (group_snap.data() as entity_model.groupDoc).groups.forEach(
        (group_obj) => {
          groups.push(group_obj);
        }
      );
    }

    // 2. ALL ENTITY STRUCTURE DOCS HAVE BEEN LOADED - PROCEED

    // remove values from drivers to be left with accounts/rollups to resolve for dependency checks
    // console.log(
    //   `Entity structs loaded. Proceed to filyer driver list for 'acct' types only. driver_lst: ${JSON.stringify(
    //     driver_lst
    //   )}`
    // );
    const driver_accts: driver_model.driverEntry[] = driver_lst.filter(
      (driver_entry) => {
        return driver_entry.type === "acct";
      }
    );

    // console.log(`filtered driver entries: ${JSON.stringify(driver_accts)}`);

    const acct_list: string[] = [];
    driver_accts.forEach((drv_acct) => {
      acct_list.push((drv_acct.entry as driver_model.driverAcct).id);
    });

    // console.log(`acct string array: ${JSON.stringify(acct_list)}`);

    return resolveRollups(
      acct_list,
      entity,
      rollups,
      div_dict,
      acct_dict,
      groups
    );
  } catch (error) {
    console.log("Error occured during driver dependency build: " + error);
    return;
  }
}

function acctIsRollup(
  driver_account: string,
  entity: entity_model.entityDoc,
  rollups: entity_model.rollupObj[]
): boolean {
  // if the level of the account is NOT dept, then it's definitely a driver
  // console.log(`checking ${JSON.stringify(driver_account)} for rollup identity`);
  // if(driver_account.level !== "dept") return true;

  // if the level IS dept, we need to evaluate the account code
  const acct = utils.extractAcctFromFullAccount(
    driver_account,
    [entity.full_account, entity.full_account_export],
    "acct"
  );
  // console.log(`retrieved code ${acct} from extraction function`);

  const rollup_idx = rollups.findIndex((rollup_obj) => {
    //console.log(`looking for ${acct} in ${JSON.stringify(rollup_obj)}`);
    return rollup_obj.rollup === acct;
  });
  // console.log(`rollup findIndex returned: ${rollup_idx}`);
  if (rollup_idx !== -1) {
    // console.log(`acct ${driver_account} is rollup`);
    return true;
  }

  return false;
}

function getRollupChildren(
  driver_account: string,
  entity: entity_model.entityDoc,
  div_dict: entity_model.divDict,
  groups: entity_model.groupObj[],
  rollups: entity_model.rollupObj[],
  acct_dict: entity_model.acctDict
) {
  // Extract the acct elements
  const acct_format_strings = [entity.full_account];
  if (entity.div_account !== undefined)
    acct_format_strings.push(entity.div_account);
  const acct_components = utils.extractComponentsFromFullAccountString(
    driver_account,
    acct_format_strings
  );

  // make sure we have dept and acct ids
  if (acct_components.acct === "" || acct_components.div === "")
    throw new Error("Unable to find div or acct id");

  // build full string WITHOUT dept
  const full_acct_no_dept = entity.full_account
    .replace("@acct@", acct_components.acct)
    .replace("@div@", acct_components.div);

  const ret_acct_list: string[] = [];
  // console.log(
  //   `begin case evaluation for finding rollupc hildren for ${driver_account}`
  // );

  // console.log(`acct_components: ${JSON.stringify(acct_components)}`);
  // console.log(`full_acct_no_dept: ${full_acct_no_dept}`);

  // 1. DIV => go to DEPTS
  if (acct_components.dept === undefined) {
    // console.log("its a div");
    for (const add_dept_id of div_dict[acct_components.div].depts) {
      ret_acct_list.push(full_acct_no_dept.replace("@dept@", add_dept_id));
    }
    // console.log(`replaced parent with ${ret_acct_list}`);
    return ret_acct_list;
  }

  // 2. GROUP => Go to GROUP CHILDREN (DEPTS)
  const group_items = groups.filter((group_obj) => {
    return group_obj.code === acct_components.dept;
  });
  if (group_items.length > 0) {
    // console.log("its a group");
    for (const grp_child of group_items[0].children) {
      ret_acct_list.push(full_acct_no_dept.replace("@dept@", grp_child));
    }
    // console.log(`replaced parent with ${ret_acct_list}`);
    return ret_acct_list;
  }

  // console.log("roll down acctrollup");
  // 3. It's not a GROUP or DIV, so now we roll down the ACCT LEVEL
  const full_acct_no_acct = entity.full_account
    .replace("@dept@", acct_components.dept)
    .replace("@div@", acct_components.div);
  // console.log(`full_acct_no_acct: ${full_acct_no_acct}`);
  const rollup_items = rollups.filter((rollup_obj) => {
    return rollup_obj.rollup === acct_components.acct;
  });
  if (rollup_items.length > 0) {
    // console.log(`found rollup definition: ${JSON.stringify(rollup_items)}`);

    // More rollups?
    if (rollup_items[0].child_rollups !== undefined) {
      for (const rollup_id of Object.keys(rollup_items[0].child_rollups)) {
        // console.log("adding rollup child");
        ret_acct_list.push(full_acct_no_acct.replace("@acct@", rollup_id));
      }
      // found rollups, we can return now
      // console.log(`replaced parent with ${JSON.stringify(ret_acct_list)}`);
      return ret_acct_list;
    }

    // If we get here, the rollup does not have further rollup children, we need to find
    // n-level accounts to return
    // console.log("adding nlevel accts");
    const acct_list = Object.entries(acct_dict).filter(
      ([item_acct_id, acct_map]) => acct_map.type === acct_components.acct
    );
    // console.log(
    //   `acct_list where type is the rollup account: ${JSON.stringify(acct_list)}`
    // );
    for (const acct_item of acct_list) {
      if (!acct_dict[acct_item[0]].depts.includes(acct_components.dept))
        continue;

      const upd_acct = full_acct_no_acct.replace("@acct@", acct_item[0]);
      ret_acct_list.push(upd_acct);
    }
    // console.log(`replaced parent with ${ret_acct_list}`);
    return ret_acct_list;
  }

  console.log(
    "Unable to findChildren for rollup -- this should not happen but is not fatal."
  );
  return [];
}

function resolveRollups(
  acct_lst: string[],
  entity: entity_model.entityDoc,
  rollups: entity_model.rollupObj[],
  div_dict: entity_model.divDict,
  acct_dict: entity_model.acctDict,
  groups: entity_model.groupObj[]
): string[] {
  // console.log(`running resolveRollups for ${acct_lst}`);
  let acct_lst_copy = acct_lst;
  for (let idx = acct_lst_copy.length - 1; idx >= 0; idx--) {
    if (acctIsRollup(acct_lst_copy[idx], entity, rollups)) {
      // console.log(
      //   `detected rollup -- slice and concatenate, call recursively for rollup`
      // );
      acct_lst_copy = acct_lst_copy
        .slice(0, idx)
        .concat(
          resolveRollups(
            getRollupChildren(
              acct_lst_copy[idx],
              entity,
              div_dict,
              groups,
              rollups,
              acct_dict
            ),
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
  return acct_lst_copy;
}