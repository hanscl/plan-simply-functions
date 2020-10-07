import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as https_utils from "./https_utils";
import * as plan_model from "./plan_model";

const cors = require("cors")({ origin: true });
//const key = require("../alert-condition-291223-fe5b366c5ed9.json");

const db = admin.firestore();

export const createVersionFromExisting = functions.https.onRequest(async (request, response) => {
  cors(request, response, async () => {
    try {

        //     let requestedUid = request.body.     // resource the user is requsting to modify
        const authToken = https_utils.validateHeader(request); // current user encrypted

        if (!authToken) {
          response.status(403).send("Unauthorized! Missing auth token!");
          return;
        }

        console.log(`USE THIS:[${authToken}]`);
        const dec_token = await https_utils.decodeAuthToken(authToken);

        if(dec_token === undefined) {
          response.status(403).send("Invalid token.");
          return;
        }

        const user_snap = await db.doc(`users/${dec_token}`).get();
        if(!user_snap.exists) {
          response.status(403).send("User not known in this system!");
          return;
        }

        const dup_ver_params = request.body as plan_model.duplicateVersionParams;

        console.log(
          `Running function for entity ${dup_ver_params.entity}`
        );

        const entity_ref = db.doc(`entities/${dup_ver_params.entity}`);
        const plan_doc_from = await getPlanDocFromName(entity_ref, dup_ver_params.copy_from.plan_name);
        const version_doc_from = await getVersionDocFromName(plan_doc_from.ref, dup_ver_params.copy_from.version_name);
        const plan_ref_to = await getPlanDocFromName(entity_ref, dup_ver_params.copy_to.plan_name);

        const version_from = version_doc_from.data() as plan_model.versionDoc;

       // const version_doc_from = version_ref_from 


        // create the version document
        const new_version_doc: plan_model.versionDoc = {
          calculated: false,
          last_update: admin.firestore.Timestamp.now(),
          name: dup_ver_params.copy_to.version_name,

        }
        const version_ref_to = plan_ref_to.
        /

        console.log(`Executing createVersionFromExisting`);
    } catch (error) {
      console.log(`Error while duplicating version: ${JSON.stringify(error)}`);
    }
  });
});

async function getPlanDocFromName(entity_ref:FirebaseFirestore.DocumentReference, plan_name: string): Promise<FirebaseFirestore.DocumentSnapshot> {
  // search for plan name
  const plan_coll_snap = await entity_ref.collection("plans").where("name", "==", plan_name).get();
  if(plan_coll_snap.empty) throw new Error(`Plan with name ${plan_name} not found for entity ${entity_ref.id}`);

  // return the ref
  return plan_coll_snap.docs[0];
}

async function getVersionDocFromName(plan_ref:FirebaseFirestore.DocumentReference, version_name: string): Promise<FirebaseFirestore.DocumentSnapshot> {
  // search for plan name
  const ver_coll_snap = await plan_ref.collection("versions").where("name", "==", version_name).get();
  if(ver_coll_snap.empty) throw new Error(`Version with name ${version_name} not found for plan ${plan_ref.id}`);

  // return the ref
  return ver_coll_snap.docs[0];
}

async function getNextVersionNumber(plan_ref: FirebaseFirestore.DocumentReference) {
  const vers_coll_snap = plan_ref.collection("versions").
}