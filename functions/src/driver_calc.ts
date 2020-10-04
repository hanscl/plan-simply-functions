import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as labor_model from "./labor_model";
import * as plan_model from "./plan_model";
import * as utils from "./utils";

const db = admin.firestore();

interface contextParams {
  entity_id: string;
  position_id: string;
  plan_id?: string;
  version_id: string;
}

export const laborEntryUpdate = functions.firestore
  .document("entities/{entityId}/labor/{versionId}/positions/{positionId}")
  .onWrite(async (snapshot, context) => {
    try {
        const res = await db.runTransaction(async t => {
            await recalcVersion(t)
        })

    } catch (error) {
      console.log(`Error occured while : ${error}`);
    }
  });


  async function recalcVersion(trans) {

  }
