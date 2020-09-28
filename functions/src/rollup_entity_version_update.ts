import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as entity_model from "./entity_model";
import * as plan_model from "./plan_model";
import * as utils from "./utils";

const db = admin.firestore();

interface contextParams {
  entity_id: string;
  plan_id: string;
  version_id: string;
}

// TODO: This needs to be also triggered on new entity create
export const rebuildRollupEntityHierarchy = functions.firestore
  .document("entities/{entityId}/plans/{planId}/versions/{versionId}")
  .onUpdate(async (snapshot, context) => {
    try {
        const version_before = snapshot.before.data() as plan_model.versionDoc;
        const version_after = snapshot.after.data() as plan_model.versionDoc;
        const context_params: contextParams = {
            entity_id: context.params.entityId,
            plan_id: context.params.planId,
            version_id: context.params.versionId
          };
  
        // Process only if the version was recalculated and is ready for view 
        // Same as when the version is ready for the view within its own entity
        if (
          version_after.ready_for_view === false ||
          version_before.ready_for_view === version_after.calculated
        ) {
          console.log(`Version ${context_params.version_id} for entity ${context_params.entity_id} was updated, but state did not change to trigger view build in rollup entity.`);
          return;
        }
        
        console.log(`Version ${context_params.version_id} for entity ${context_params.entity_id} was updated, but state did not change to trigger view build in rollup entity.`);
          
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


      }
    } catch (error) {
      console.log(`Error occured while rebuilding rollup entity hierarchy from children: ${error}`);
      return;
    }
  });
