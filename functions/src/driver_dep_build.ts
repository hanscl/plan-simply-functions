import { _userWithOptions } from "firebase-functions/lib/providers/auth";
import * as driver_model from "./driver_model";
import * as entity_model from "./entity_model";
import * as plan_model from "./plan_model";
import * as utils from "./utils";

export async function begin_dependency_build(
  db: FirebaseFirestore.Firestore,
  context_params: driver_model.contextParams,
  driver_lst: (string | number)[]
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
    const rollup_docId = (plan_doc_snap.data() as plan_model.planDoc)
      .account_rollup;

    // rollup and group document path
    const rollup_doc_path = `entities/${context_params.entityId}/account_rollups/${rollup_docId}`;
    // load rollups
    const rollup_coll_snap = await db
      .collection(`${rollup_doc_path}/rollups`)
      .get();
    const rollups: entity_model.rollupDoc[] = [];
    rollup_coll_snap.forEach((rollup_doc) => {
      rollups.push(rollup_doc.data() as entity_model.rollupDoc);
    });
    // load groups
    const group_coll_snap = await db
      .collection(`${rollup_doc_path}/groups`)
      .get();
    const groups: entity_model.groupDoc[] = [];
    group_coll_snap.forEach((group_doc) => {
      groups.push(group_doc.data() as entity_model.groupDoc);
    });

    // 2. ALL ENTITY STRUCTURE DOCS HAVE BEEN LOADED - PROCEED

    // remove values from drivers to be left with accounts/rollups to resolve for dependency checks
    const driver_accts: string[] = driver_lst.filter((driver) => {
      return typeof driver === "string";
    }) as string[];

    return(resolveRollups(
      driver_accts,
      entity,
      rollups,
      div_dict,
      acct_dict,
      groups
    ));
  } catch (error) {
    console.log("Error occured during driver dependency build: " + error);
    return;
  }
}

function acctIsRollup(
  full_acct: string,
  entity: entity_model.entityDoc,
  rollups: entity_model.rollupDoc[]
): boolean {
  const acct = utils.extractAcctFromFullAccount(
    full_acct,
    [entity.full_account, entity.full_account_export],
    "acct"
  );
  // extract acct from full account
  if (
    rollups.findIndex((rollup_obj) => {
      rollup_obj.rollup === acct;
    }) !== -1
  ) {
    console.log(`acct ${full_acct} is rollup`);
    return true;
  }

  return false;
}

function getRollupChildren(
  full_acct: string,
  entity: entity_model.entityDoc,
  div_dict: entity_model.divDict,
  groups: entity_model.groupDoc[],
  rollups: entity_model.rollupDoc[],
  acct_dict: entity_model.acctDict
) {
  const acct_format_strings = [entity.full_account, entity.full_account_export];
  // Extract the acct elements
  const dept_id = utils.extractAcctFromFullAccount(
    full_acct,
    acct_format_strings,
    "dept"
  );
  const div_id = utils.extractAcctFromFullAccount(
    full_acct,
    acct_format_strings,
    "div"
  );
  const acct_id = utils.extractAcctFromFullAccount(
    full_acct,
    acct_format_strings,
    "acct"
  );

  // make sure we have dept and acct ids
  if (acct_id === undefined || div_id === undefined)
    throw new Error("Unable to find div or acct id");

  // build full string WIHTOUT dept & WITHOUT acct
  const full_acct_no_dept = entity.full_account
    .replace("@acct@", acct_id)
    .replace("@div@", div_id);

  const ret_acct_list: string[] = [];

  // 1. DIV => go to DEPTS
  if (dept_id === undefined) {
    for (const dept_id of div_dict[div_id].depts) {
      ret_acct_list.push(full_acct_no_dept.replace("@dept@", dept_id));
    }

    return ret_acct_list;
  }

  // 2. GROUP => Go to GROUP CHILDREN (DEPTS)
  const group_items = groups.filter((group_obj) => {
    group_obj.code === dept_id;
  });
  if (group_items.length > 0) {
    const ret_acct_list: string[] = [];
    for (const grp_child of group_items[0].children) {
      ret_acct_list.push(full_acct_no_dept.replace("@dept@", grp_child));
    }

    return ret_acct_list;
  }

  // 3. It's not a GROUP or DIV, so now we roll down the ACCT LEVEL
  const full_acct_no_acct = entity.full_account
    .replace("@acct@", acct_id)
    .replace("@div@", div_id);
  const rollup_items = rollups.filter((rollup_obj) => {
    rollup_obj.rollup === acct_id;
  });
  if (rollup_items.length > 0) {
    // More rollups?
    for (const rollup_id of rollup_items[0].child_rollups) {
      ret_acct_list.push(full_acct_no_acct.replace("@acct@", rollup_id));
    }
    if (ret_acct_list.length > 0) {
      // found rollups, we can return now
      return ret_acct_list;
    }

    // If we get here, the rollup does not have further rollup children, we need to find
    // n-level accounts to return
    const acct_list = Object.entries(acct_dict).filter(
      ([acct_id, acct_map]) => acct_map.type === acct_id
    );
    for (const nlevel_acct_id of Object.keys(acct_list)) {
      ret_acct_list.push(full_acct_no_acct.replace("@acct@", nlevel_acct_id));
    }

    return ret_acct_list;
  }

  console.log(
    "Unable to findCHildren for rollup -- this should not happen but is not fatal."
  );
  return [];
}

function resolveRollups(
  acct_lst: string[],
  entity: entity_model.entityDoc,
  rollups: entity_model.rollupDoc[],
  div_dict: entity_model.divDict,
  acct_dict: entity_model.acctDict,
  groups: entity_model.groupDoc[]
): string[] {
  for (let idx = acct_lst.length - 1; idx >= 0; idx--) {
    if (acctIsRollup(acct_lst[idx], entity, rollups)) {
      acct_lst = acct_lst
        .slice(0, idx)
        .concat(
          resolveRollups(
            getRollupChildren(
              acct_lst[idx],
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
          acct_lst.slice(idx + 1)
        );
    }
  }
  return acct_lst;
}
