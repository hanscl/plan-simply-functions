import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as https_utils from "./https_utils";
import * as version_recalc from "./version_rollup_recalc_master";
import * as config from "./config";
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

export const saveItemizedEntry = functions.region(config.cloudFuncLoc).https.onRequest(async (request, response) => {
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

      const dec_token = await https_utils.decodeAuthToken(authToken);

      if (dec_token === undefined) {
        response.status(403).send("Invalid token.");
        return;
      }

      console.log(`uid: ${dec_token}`);

      const user_snap = await db.doc(`users/${dec_token}`).get();
      if (!user_snap.exists) {
        response.status(403).send("User not known in this system!");
        return;
      }

      const recalc_request = request.body as recalcParams;
      console.log(
        `Running itemized entry update for entity ${recalc_request.entity_id} and version ${recalc_request.version_id} with account ${
          recalc_request.acct_id
        }. Values: ${JSON.stringify(recalc_request.values)}`
      );

      let user_req = true;
      if (dec_token === "5f7vMkqH6ffINY7RoPomdDVrhnE2" || dec_token === "Cf4y9PEkLMUo8maMMmJHj1BhaA73") user_req = false;

      await version_recalc.beginVersionRollupRecalc(recalc_request, user_req, "entry");

      response.status(200).send({ result: `Itemized Entry Function completed successfully.` });
    } catch (error) {
      console.log(`Error occured during itemized entry update: ${error}`);
      response.sendStatus(500);
    }
  });
});
