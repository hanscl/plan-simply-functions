import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as entity_model from "./entity_model";
import * as plan_model from "./plan_model";

const db = admin.firestore();

export const versionDocCreate = functions.firestore
  .document("entities/{entityId}/plans/{planId}/versions/{versionId}")
  .onCreate(async (snapshot, context) => {
    try {
      // set the correct locking based on the entity and plan type
      const entity_doc = await db.doc(`entities/${context.params.entityId}`).get();
      if (!entity_doc.exists) throw new Error("Entity doc not found. Fatal!");
      const entity_type = (entity_doc.data() as entity_model.entityDoc).type;

      const plan_doc = await entity_doc.ref.collection("plans").doc(context.params.planId).get();
      if (!plan_doc.exists) throw new Error("Plan doc not found. Fatal!");
      const plan_type = (plan_doc.data() as plan_model.planDoc).type;

      let lock_val = false;
      if (entity_type === "rollup" || plan_type === "Actuals") lock_val = true;

      const lock_status: plan_model.versionLockStatus = {
        all: lock_val,
        periods: [lock_val, lock_val, lock_val, lock_val, lock_val, lock_val, lock_val, lock_val, lock_val, lock_val, lock_val, lock_val],
      };

      await plan_doc.ref.collection("versions").doc(context.params.versionId).update({ is_locked: lock_status });
    } catch (error) {
      console.log("Error occured while initializing lock status of new version document: " + error);
      return;
    }
  });
