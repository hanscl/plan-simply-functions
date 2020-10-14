import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as driver_model from "./driver_model";
import * as driver_dependencies from "./driver_dependencies";
import * as driver_calc from "./driver_calc";
import * as utils from "./utils";
import { QueryDocumentSnapshot } from "firebase-functions/lib/providers/firestore";

const db = admin.firestore();

export const driverDocUpdate = functions.firestore
  .document("entities/{entityId}/drivers/{versionId}/dept/{acctId}")
  .onUpdate(async (snapshot, context) => {
    try {
      // if the "referenced accounts" changed then this is a retrigger from the API function and muste be ignored
      if (
        JSON.stringify((snapshot.before.data() as driver_model.acctDriverDef).ref_accts) !==
        JSON.stringify((snapshot.after.data() as driver_model.acctDriverDef).ref_accts)
      ) {
        console.log(`driver snapshot unchanged. exiting`);
        return;
      }

      if(await driverDocNullCheck(snapshot.after)) {
        console.log(`drivers were updated. exit function -- this will be called again`);
        return;
      }

      console.log(`no nulls found. proceeding with processing drivers`);
      await processDriverDocChange(snapshot.after, {
        entity_id: context.params.entityId,
        version_id: context.params.versionId,
        acct_id: context.params.acctId,
      });
    } catch (error) {
      console.log("Error occured while processing driver doc: " + error);
      return;
    }
  });

export const driverDocCreate = functions.firestore
  .document("entities/{entityId}/drivers/{versionId}/dept/{acctId}")
  .onCreate(async (snapshot, context) => {
    try {
      // ensure that we have a driver doc for this version & create it if we don't
      await createVersionDriverDoc(context.params.entityId, context.params.versionId);

      if(await driverDocNullCheck(snapshot)) {
        console.log(`drivers were updated. exit function -- this will be called again`);
        return;
      }

      console.log(`no nulls found. proceeding with processing drivers`);

      await processDriverDocChange(snapshot, { entity_id: context.params.entityId, version_id: context.params.versionId, acct_id: context.params.acctId });
    } catch (error) {
      console.log("Error occured while updating driver doc: " + error);
      return;
    }
  });

async function processDriverDocChange(snapshot: admin.firestore.QueryDocumentSnapshot, context_params: driver_model.driverParamsContext) {
  // get the plan & version IDs from the driver document
  const driver_doc_ref = db.doc(`entities/${context_params.entity_id}/drivers/${context_params.version_id}`);
  const driver_doc = await driver_doc_ref.get();
  if (!driver_doc.exists) throw new Error(`Driver document not found: ${JSON.stringify(driver_doc_ref.path)}`);

  console.log(`completing context params`);
  // complete the necessary context parameters
  const driver_params: driver_model.driverParamsAll = { ...context_params, plan_id: (driver_doc.data() as driver_model.driverDoc).plan_id };

  console.log(`getting driver definition`);
  // Get the acct driver definition from the document
  const acct_driver_definition = snapshot.data() as driver_model.acctDriverDef;

  console.log(`recalcing driver value`);
  /******** 1. RECALC THE DRIVER VALUE ***************/
  await driver_calc.driverCalcValue(acct_driver_definition, driver_params);

  /******** 2. UPDATE DRIVER DEPENDENCIES ***************/
  const nlevel_ref_accts = await driver_dependencies.driverDependencyBuild(driver_params, acct_driver_definition.drivers, driver_params);
  if (nlevel_ref_accts === undefined) throw new Error("Account dependency build returned undefined");
  console.log(`Account list resolved from "${JSON.stringify(acct_driver_definition.drivers)}" to "${JSON.stringify(nlevel_ref_accts)}"`);

  // update the data object and also write to firestore
  acct_driver_definition.ref_accts = nlevel_ref_accts;
  await snapshot.ref.update({ ref_accts: nlevel_ref_accts });
}

async function createVersionDriverDoc(entity_id: string, version_id: string) {
  try {
    const driver_doc = await db.doc(`entities/${entity_id}/drivers/${version_id}`).get();
    if (driver_doc.exists) return;

    // find the correct plan_id
    const plan_snap = await db.collection(`entities/${entity_id}/plans`).get();
    for (const plan of plan_snap.docs) {
      const version_doc = await plan.ref.collection(`versions`).doc(version_id).get();
      if (version_doc.exists) {
        await db.doc(`entities/${entity_id}/drivers/${version_id}`).set({ version_id: version_id, plan_id: plan.id });
        return;
      }
    }
  } catch (error) {
    console.log(`Error during [createVersionDriverDoc]: ${error}`);
  }
}

export async function deleteDriverDefinition(entity_id: string, plan_id: string, version_id: string, acct_id: string) {
  try {
    await db.doc(`entities/${entity_id}/plans/${plan_id}/versions/${version_id}/dept/${acct_id}`).delete();
  } catch (error) {
    console.log(`Error occured during [deleteDriverDefinition]: ${error}`);
  }
}

async function driverDocNullCheck(snapshot_after: QueryDocumentSnapshot): Promise<boolean> {
  const driver_def = snapshot_after.data() as driver_model.acctDriverDef;
  console.log(`driver_before: ${JSON.stringify(driver_def)}`);
  let rewrite_req: boolean = false;
  for (const driver_entry of driver_def.drivers) {
    if (driver_entry.type === "value") {
      if (utils.valuesNullConversion(driver_entry.entry as number[]) === true) rewrite_req = true;
    }
    console.log(`driver_after: ${JSON.stringify(driver_def)}`);

    if (rewrite_req === true) {
      console.log(`updating driver doc`);
      await snapshot_after.ref.update(driver_def);
    }
  }
  return rewrite_req;
}
