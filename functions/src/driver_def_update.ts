import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as dep_build from "./driver_dep_build";
import * as driver_model from "./driver_model";

const db = admin.firestore();

export const driverDefinitionUpdate = functions.firestore
  .document("entities/{entityId}/drivers/{driverDocId}/dept/{acctId}")
  .onUpdate(async (snapshot, context) => {
    try {
      const new_driver_def = snapshot.after.data() as driver_model.acctDriverDef;
      //const old_driver_def = snapshot.before.data() as driver_model.acctDriverDef;

      // if(JSON.stringify(new_driver_def) === JSON.stringify(old_driver_def)) {
      //   console.log(`Driver definition was not changed. Not rebuilding the dependencies`);
      //   return;
      // }

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
        versionId: context.params.driverDocId,
      };

      const nlevel_ref_accts = await dep_build.begin_dependency_build(
        db,
        context_params,
        new_driver_def.drivers
      );

      if (nlevel_ref_accts === undefined) {
        throw new Error("Account dependency build returned undefined");
      }

      console.log(
        `Account list resolved from "${JSON.stringify(
          new_driver_def.drivers
        )}" to "${JSON.stringify(nlevel_ref_accts)}"`
      );

      if (nlevel_ref_accts.length > 0) {
        new_driver_def.ref_accts = nlevel_ref_accts;

        // update driver entry for account
        await driver_doc_snap.ref
          .collection("dept")
          .doc(context_params.acctId)
          .update({ ref_accts: nlevel_ref_accts });
      }
    } catch (error) {
      console.log("Error occured during creation of driver for acct: " + error);
      return;
    }
  });
