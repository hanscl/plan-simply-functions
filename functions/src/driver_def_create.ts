import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as dep_build from "./driver_dep_build";
import * as driver_model from "./driver_model";

const db = admin.firestore();

export const driverDefinitionCreate = functions.firestore
  .document("entities/{entityId}/drivers/{driverDocId}/dept/{acctId}")
  .onCreate(async (snapshot, context) => {
    try {
      const new_driver_def = snapshot.data() as driver_model.acctDriverDef;

      // get the plan & version IDs from the driver document
      const driver_doc_path = `entities/${context.params.entityId}/drivers/${context.params.driverDocId}`;
      const driver_doc_snap = await db.doc(driver_doc_path).get();
      if (!driver_doc_snap.exists)
        throw new Error(`Driver doc not found: ${driver_doc_path}`);

      const context_params: driver_model.contextParams = {
        entityId: context.params.entityId,
        driverDocId: context.params.driverDocId,
        acctId: context.params.acctId,
        planId: (driver_doc_snap.data() as driver_model.driverDoc).plan_id,
        versionId: (driver_doc_snap.data() as driver_model.driverDoc)
          .version_id,
      };

      const nlevel_ref_accts = await dep_build.begin_dependency_build(
        db,
        context_params,
        new_driver_def.drivers
      );

      if(nlevel_ref_accts === undefined) {
        throw new Error("Account dependency build returned undefined");
      }

      console.log(
        `Account list resolved from "${new_driver_def.drivers}" to "${nlevel_ref_accts}"`
      );

      new_driver_def.ref_accts = nlevel_ref_accts;
    } catch (error) {
      console.log("Error occured during creation of driver for acct: " + error);
      return;
    }
  });
