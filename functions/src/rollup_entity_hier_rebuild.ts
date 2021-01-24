import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as entity_model from "./entity_model";
import * as utils from "./utils/utils";

const db = admin.firestore();

interface contextParams {
  entity_id: string;
}

// TODO: This needs to be also triggered on new entity create
export const rebuildRollupEntityHierarchy = functions.firestore
  .document("entities/{entityId}/entity_structure/hier")
  .onWrite(async (snapshot, context) => {
    try {
        const hier_before = snapshot.before.data() as entity_model.hierDoc;
        const hier_after = snapshot.after.data() as entity_model.hierDoc;
        const context_params: contextParams = {
            entity_id: context.params.entityId,
          };
  
        // Process only if the hier was updated and is ready
        if (
          hier_before === undefined ||
          hier_before.ready_for_rollup === null || 
          hier_after.ready_for_rollup === null ||
          hier_after.ready_for_rollup === false ||
          hier_after.ready_for_rollup === hier_before.ready_for_rollup
        ) {
          console.log(`HIER document either not ready for rollup or state was unchanged.`);
          return;
        }

        console.log(`HIER doc changed -- continue update of rollup entity`);

      // find all entities that this entity rolls up to
      const rollup_entities_snap = await db
        .collection(`entities`)
        .where("type", "==", "rollup")
        .where("children", "array-contains", context_params.entity_id)
        .get();

      if (rollup_entities_snap.empty) {
        console.log(
          `No rollup entities have ${context_params.entity_id} as a child`
        );
        return;
      }

      // process all rollup entities
      for (const rollup_entity_doc of rollup_entities_snap.docs) {
        const rollup_entity = rollup_entity_doc.data() as entity_model.entityDoc;

        // Create empty
        let rollup_acct_dict: entity_model.acctDict | undefined = undefined;
        let rollup_dept_dict: entity_model.deptDict | undefined = undefined;
        let rollup_div_dict: entity_model.divDict | undefined = undefined;
        // repeat for all children
        if (rollup_entity.children === undefined)
          throw new Error("Unexpected error: Rollup entity has no children");
        for (const child_id of rollup_entity.children) {
          // query this entity's acct/dept/div structure
          const child_acct_snap = await db
            .doc(`entities/${child_id}/entity_structure/acct`)
            .get();
          const child_dept_snap = await db
            .doc(`entities/${child_id}/entity_structure/dept`)
            .get();
          const child_div_snap = await db
            .doc(`entities/${child_id}/entity_structure/div`)
            .get();
            // console.log(`finished getting child entity docs for ${child_id}`);
          if (
            !child_acct_snap.exists ||
            !child_dept_snap.exists ||
            !child_div_snap.exists
          )
            throw new Error(
              `Entity structure of ${child_id} incomplete. Please check existence of "div", "dept" and "acct" docs!`
            );

          // IF this is the first child entities, simply assign the data to our variable
          if (
            rollup_acct_dict === undefined ||
            rollup_dept_dict === undefined ||
            rollup_div_dict === undefined
          ) {
            // console.log(`assigning dicts for the first time`);
            rollup_acct_dict = child_acct_snap.data() as entity_model.acctDict;
            rollup_dept_dict = child_dept_snap.data() as entity_model.deptDict;
            rollup_div_dict = child_div_snap.data() as entity_model.divDict;
            // console.log(
            //   `dicts before replace: DIV -- ${JSON.stringify(
            //     rollup_div_dict
            //   )} DEPT -- ${JSON.stringify(
            //     rollup_dept_dict
            //   )} ACCT -- ${JSON.stringify(rollup_acct_dict)}`
            // );
            // console.log(`Rollup Entity: ${JSON.stringify(rollup_entity)}`);
            // replace entity_ids
            replaceEntityIds(
              rollup_entity,
              rollup_acct_dict,
              rollup_dept_dict,
              rollup_div_dict
            );
            // console.log(
            //     `dicts after replace: DIV -- ${JSON.stringify(
            //       rollup_div_dict
            //     )} DEPT -- ${JSON.stringify(
            //       rollup_dept_dict
            //     )} ACCT -- ${JSON.stringify(rollup_acct_dict)}`
            //   );
          }
          // This is not the first child, we need to proceed with merging the entity structures!
          else {
            // console.log(`2nd+ child for rollup`);
            const child_acct_dict = child_acct_snap.data() as entity_model.acctDict;
            const child_dept_dict = child_dept_snap.data() as entity_model.deptDict;
            const child_div_dict = child_div_snap.data() as entity_model.divDict;

            replaceEntityIds(
              rollup_entity,
              child_acct_dict,
              child_dept_dict,
              child_div_dict
            );

            mergeAcctOrDivDicts(rollup_acct_dict, child_acct_dict);
            mergeAcctOrDivDicts(rollup_div_dict, child_div_dict);
            mergeDeptDicts(rollup_dept_dict, child_dept_dict);
          }
        }
        // save to database in one batch
        // console.log(
        //   `saving dicts to ${rollup_entity_doc.id}: ${JSON.stringify(
        //     rollup_acct_dict
        //   )} - ${JSON.stringify(rollup_dept_dict)} - ${JSON.stringify(
        //     rollup_div_dict
        //   )}`
        // );
        const wx_batch = db.batch();
        wx_batch.set(
          db.doc(`entities/${rollup_entity_doc.id}/entity_structure/acct`),
          rollup_acct_dict
        );
        wx_batch.set(
          db.doc(`entities/${rollup_entity_doc.id}/entity_structure/dept`),
          rollup_dept_dict
        );
        wx_batch.set(
          db.doc(`entities/${rollup_entity_doc.id}/entity_structure/div`),
          rollup_div_dict
        );
        await wx_batch.commit();
      }
    } catch (error) {
      console.log(`Error occured while rebuilding rollup entity hierarchy from children: ${error}`);
      return;
    }
  });

function mergeAcctOrDivDicts(
  baseDict: entity_model.acctDict | entity_model.divDict,
  newDict: entity_model.acctDict | entity_model.divDict
) {
  for (const acct_or_div_id of Object.keys(newDict)) {
    if (!Object.keys(baseDict).includes(acct_or_div_id)) {
      baseDict[acct_or_div_id] = newDict[acct_or_div_id];
      //   console.log(
      //     `Adding new acct or div from newDict to baseDict: ${acct_or_div_id}`
      //   );
    } else {
      //   console.log(
      //     `Acct or Div already exists: ${acct_or_div_id}. Checking depts:`
      //   );
      for (const dept_id of newDict[acct_or_div_id].depts) {
        if (!baseDict[acct_or_div_id].depts.includes(dept_id)) {
          baseDict[acct_or_div_id].depts.push(dept_id);
          //console.log(`Adding dept to depts array: ${dept_id}`);
        }
      }
    }
  }
}

function mergeDeptDicts(
  baseDict: entity_model.deptDict,
  newDict: entity_model.deptDict
) {
  for (const dept_id of Object.keys(newDict)) {
    if (!Object.keys(baseDict).includes(dept_id)) {
      baseDict[dept_id] = newDict[dept_id];
      //console.log(`Adding dept_id from newDict to baseDict: ${dept_id}`);
    }
  }
}

// TODO: modify if future clients embed the entity elsewhere
function replaceEntityIds(
  rollup_entity: entity_model.entityDoc,
  rollup_acct_dict: entity_model.acctDict,
  rollup_dept_dict: entity_model.deptDict,
  rollup_div_dict: entity_model.divDict
) {
  if (rollup_entity.entity_embeds === undefined) return;

  // parse through all dicts
  for (const acct_id of Object.keys(rollup_acct_dict)) {
    // console.log(`acct entry before replace: ${JSON.stringify(rollup_acct_dict[acct_id])}`);
    substituteEntityInDeptList(
      rollup_acct_dict[acct_id].depts,
      rollup_entity.entity_embeds,
      rollup_entity.number
    );
    // console.log(`acct entry after replace: ${JSON.stringify(rollup_acct_dict[acct_id])}`);
  }
  const dept_keys = Object.keys(rollup_dept_dict);
  for (const dept_id of dept_keys) {
    const newKey = utils.substituteEntityForRollup(
      dept_id,
      rollup_entity.entity_embeds,
      rollup_entity.number
    );
    rollup_dept_dict[newKey] = rollup_dept_dict[dept_id];
    delete rollup_dept_dict[dept_id];
  }
  for (const div_id of Object.keys(rollup_div_dict)) {
    substituteEntityInDeptList(
      rollup_div_dict[div_id].depts,
      rollup_entity.entity_embeds,
      rollup_entity.number
    );
  }
}

function substituteEntityInDeptList(
  dept_list: string[],
  embeds: entity_model.entityEmbed[],
  entity_id: string
) {
  for (let idx = 0; idx < dept_list.length; idx++) {
    dept_list[idx] = utils.substituteEntityForRollup(
      dept_list[idx],
      embeds,
      entity_id
    );
  }
}
