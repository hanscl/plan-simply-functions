import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as https_utils from "./https_utils";
import * as version_recalc from "./version_rollup_recalc_master";
const cors = require("cors")({ origin: true });

const db = admin.firestore();


interface recalcParams {
  entity_id: string;
  plan_id: string;
  version_id: string;
  acct_id: string;
  values: number[];
  dept?: string;
}

export const saveItemizedEntry = functions.https.onRequest(
  async (request, response) => {
    cors(request, response, async () => {
      try {
        response.set("Access-Control-Allow-Origin", "*");
        response.set("Access-Control-Allow-Credentials", "true");

        if (request.method === "OPTIONS") {
          response.set("Access-Control-Allow-Methods", "GET");
          response.set("Access-Control-Allow-Headers", "Authorization");
          response.set("Access-Control-Max-Age", "3600");
          response.status(204).send("");

          return;
        }

        const authToken = https_utils.validateHeader(request); // current user encrypted

        if (!authToken) {
          response.status(403).send("Unauthorized! Missing auth token!");
          return;
        }

        //console.log(`USE THIS:[${authToken}]`);
        const dec_token = await https_utils.decodeAuthToken(authToken);

        if(dec_token === undefined) {
          response.status(403).send("Invalid token.");
          return;
        }
    
        console.log(`uid: ${dec_token}`);

        const user_snap = await db.doc(`users/${dec_token}`).get();
        if(!user_snap.exists) {
          response.status(403).send("User not known in this system!");
          return;
        }

        const recalc_request = request.body as recalcParams;
        console.log(
          `Running itemized entry update for entity ${recalc_request.entity_id} and version ${recalc_request.version_id} with account ${recalc_request.acct_id}. Values: ${JSON.stringify(recalc_request.values)}`
        );

        await version_recalc.beginVersionRollupRecalc(recalc_request, true);

        response.status(200).send({result: `Function completed successfully.`});
      } catch (error) {
        console.log(`Error occured during itemized entry update: ${error}`);
        response.sendStatus(500);
      }
    });
  }
);


