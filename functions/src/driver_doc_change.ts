import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as driver_model from "./driver_model";
import * as driver_dependencies from "./driver_dependencies";

const db = admin.firestore();

export const driverDocUpdate = functions.firestore
  .document("entities/{entityId}/drivers/{versionId}/dept/{acctId}")
  .onUpdate(async (snapshot, context) => {
    try {
      // if the "referenced accounts" changed then this is a retrigger from the API function and muste be ignored
      if (
        JSON.stringify((snapshot.before.data() as driver_model.acctDriverDef).ref_accts) !==
        JSON.stringify((snapshot.after.data() as driver_model.acctDriverDef).ref_accts)
      )
        return;

      processDriverDocChange(snapshot.after, { entity_id: context.params.entityId, version_id: context.params.versionId, acct_id: context.params.acctId });
    } catch (error) {
      console.log("Error occured while processing driver doc: " + error);
      return;
    }
  });

export const driverDocCreate = functions.firestore
  .document("entities/{entityId}/drivers/{driverDocId}/dept/{acctId}")
  .onCreate(async (snapshot, context) => {
    try {
      processDriverDocChange(snapshot, { entity_id: context.params.entityId, version_id: context.params.versionId, acct_id: context.params.acctId });
    } catch (error) {
      console.log("Error occured while updating driver doc: " + error);
      return;
    }
  });

async function processDriverDocChange(snapshot: admin.firestore.QueryDocumentSnapshot, context_params: driver_model.driverParamsContext) {
  // get the plan & version IDs from the driver document
  const driver_doc_ref = db.doc(`entities/${context_params.entity_id}/drivers/${context_params.version_id}`);
  const driver_doc = await driver_doc_ref.get();
  if (!driver_doc.exists) throw new Error(`Driver document not found: ${JSON.stringify(driver_doc_ref)}`);

  // complete the necessary context parameters
  const driver_params: driver_model.driverParamsAll = { ...context_params, plan_id: (driver_doc.data() as driver_model.driverDoc).plan_id };

  // Get the acct driver definition from the document
  const acct_driver_definition = snapshot.data() as driver_model.acctDriverDef;

  /******** 1. UPDATE DRIVER DEPENDENCIES ***************/
  const nlevel_ref_accts = await driver_dependencies.driverDependencyBuild(db, driver_params, acct_driver_definition.drivers);
  if (nlevel_ref_accts === undefined) throw new Error("Account dependency build returned undefined");
  console.log(`Account list resolved from "${JSON.stringify(acct_driver_definition.drivers)}" to "${JSON.stringify(nlevel_ref_accts)}"`);

  // update the data object and also write to firestore
  acct_driver_definition.ref_accts = nlevel_ref_accts;
  await snapshot.ref.update({ ref_accts: nlevel_ref_accts });

  /******** 2. RECALC THE DRIVER VALUE ***************/


}
