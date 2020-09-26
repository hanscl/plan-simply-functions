import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as plan_model from "./plan_model";
import * as entity_model from "./entity_model";

interface contextParams {
  entityId: string;
  planId: string;
  versionId: string;
}

const db = admin.firestore();

export const planVersionHierarchyGenerate = functions.firestore
  .document("entities/{entityId}/plans/{planId}/versions/{versionId}")
  .onUpdate(async (snapshot, context) => {
    try {
      const version_before = snapshot.before.data() as plan_model.versionDoc;
      const version_after = snapshot.after.data() as plan_model.versionDoc;
      const context_params: contextParams = {
        entityId: context.params.entityId,
        planId: context.params.planId,
        versionId: context.params.versionId,
      };

      // Process only if the version was recalculated
      if (
        version_after.ready_for_view === false ||
        version_before.ready_for_view === version_after.calculated
      ) {
        console.log(`EXITING FUNCTION`);
        return;
      }

      // pull the default hierarchy
      const hier_snap = await db
        .doc(`entities/${context_params.entityId}/entity_structure/hier`)
        .get();
      if (!hier_snap.exists) throw new Error("Default Hiearchy not found.");

      const def_hier_obj = hier_snap.data() as entity_model.hierDoc;

      for (let idx = def_hier_obj.children.length - 1; idx >= 0; idx--) {
        await recursively_remove_elements(
          def_hier_obj.children,
          idx,
          def_hier_obj.children[idx],
          context_params
        );
      }
      // set new document -- do not merge!!
      await db.doc(`entities/${context_params.entityId}/entity_structure/hier/versions/${context_params.versionId}`).set(def_hier_obj);
    } catch (error) {
      console.log(
        "Error occured while generating hierarchies for plan versions: " + error
      );
      return;
    }
  });

async function recursively_remove_elements(
  parent_level: entity_model.hierLevel[],
  child_index: number,
  hier_level: entity_model.hierLevel,
  context_params: contextParams
) {
  if (hier_level.children !== undefined) {
    for (let idx = hier_level.children.length - 1; idx >= 0; idx--) {
      await recursively_remove_elements(
        hier_level.children,
        idx,
        hier_level.children[idx],
        context_params
      );
    }
  }
  // attempt to find this element in the plan version
  const coll_path = `entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/${hier_level.level}`;
  const acct_snaps = await db
    .collection(coll_path)
    .where(hier_level.level, "==", hier_level.id)
    .get();
  if (acct_snaps.empty) {
    parent_level.splice(child_index, 1);
  } 
  if (hier_level.children !== undefined && hier_level.children.length === 0) {
    hier_level.children === undefined;
  }
}
