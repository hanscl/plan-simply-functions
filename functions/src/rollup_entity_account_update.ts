import * as admin from "firebase-admin";
import * as plan_model from "./plan_model";
import * as entity_model from "./entity_model";
import * as utils from "./utils";

interface recalcParams {
  entity_id: string;
  plan_id: string;
  version_id: string;
  acct_id: string;
  values: number[];
  dept?: string;
}

interface acctChanges {
  diff_by_month: number[];
  diff_total: number;
  months_changed: number[];
  operation: number;
}

const db = admin.firestore();

/*****  TODO: MOVE INTO ITS OWN MODULE -- CALL FROM RECALC MASTER INSTEAD WITH A DIFFERENT TRANSACTION */
export async function updateAccountInRollupEntities(recalc_params: recalcParams, acct_changes: acctChanges) {
  try {
    // get the entity doc of the one that was changed initially
    const entity_snap = await db.doc(`entities/${recalc_params.entity_id}`).get();
    if (!entity_snap.exists) throw new Error("could not find entity document of the entity where the account was updated >> Fatal error.");
    const entity_obj = entity_snap.data() as entity_model.entityDoc;

    // Find rollup entities for this entity
    const rollup_ent_snaps = await db
      .collection(`entities`)
      .where("type", "==", "rollup")
      .where("children", "array-contains", recalc_params.entity_id)
      .get();

    // ... & loop through all of them
    for (const rollup_entity_doc of rollup_ent_snaps.docs) {
      const rollup_entity = rollup_entity_doc.data() as entity_model.entityDoc;
      const rollup_plan_snaps = await rollup_entity_doc.ref.collection("plans").get();

      for (const rollup_plan_doc of rollup_plan_snaps.docs) {
        await db.runTransaction(async (version_tx) => {
          const rollup_version_snaps = await version_tx.get(
            rollup_plan_doc.ref.collection("versions").where("child_version_ids", "array-contains", recalc_params.version_id)
          );

          for (const rollup_version_doc of rollup_version_snaps.docs) {
            const acct_cmpnts = utils.extractComponentsFromFullAccountString(recalc_params.acct_id, [entity_obj.full_account]);

            if (recalc_params.dept === undefined)
              throw new Error(`Dept not defined for account ${recalc_params.acct_id} in version ${recalc_params.version_id}`);

            // convert the dept string to replace the entity => IMPORTANT: update the utils to evaluate the embeds array for undefined and the field!!
            const rollup_dept_id = utils.substituteEntityForRollup(recalc_params.dept, rollup_entity.entity_embeds, rollup_entity.number);

            // create a new full account string
            const rollup_full_account = utils.buildFullAccountString([rollup_entity.full_account], { ...acct_cmpnts, dept: rollup_dept_id });

            // query the account from the rollup entity
            const rollup_acct_snap = await version_tx.get(rollup_version_doc.ref.collection("dept").doc(rollup_full_account));

            if (!rollup_acct_snap.exists) {
              console.log(`Account ${rollup_full_account} not found in version ${rollup_version_doc.id} for entity ${rollup_entity_doc.id}`);
              continue;
            }

            const rollup_account = rollup_acct_snap.data() as plan_model.accountDoc;

            for (const idx of acct_changes.months_changed) {
              rollup_account.values[idx] += acct_changes.diff_by_month[idx];
            }

            // TODO call new update function
            version_tx.update(rollup_acct_snap.ref, { values: rollup_account.values });
          }
        });
      }
    }
  } catch (error) {
    console.log(`Error when updating parent rollup version documents with child entity account update: ${error}`);
  }
}
