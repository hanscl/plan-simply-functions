import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as https_utils from "./https_utils";
import { accountDoc } from "./plan_model";
const cors = require("cors")({ origin: true });

const db = admin.firestore();

export interface laborValidationRequest {
  version_id: string;
  plan_id: string;
  path: { entity: string; div?: string; dept?: string };
}

export interface laborValidationResponse {
  valid_depts: string[];
  valid_accts: laborValidAcctsByDept[];
}

interface laborValidAcctsByDept {
  dept_id: string;
  acct_id: string;
}

export const getLaborValidations = functions.https.onRequest(async (request, response) => {
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

      const validation_request = request.body as laborValidationRequest;
      console.log(`Running itemized entry update for entity ${validation_request.path.entity} and version ${validation_request.version_id}.`);

      const dept_list: string[] = [];
      // obtain all depts
      // HACK - always show all depts 
      validation_request.path.dept = undefined;
      validation_request.path.div = undefined;
      let dept_snap: undefined | FirebaseFirestore.QuerySnapshot;
      if (validation_request.path.dept !== undefined) {
        dept_list.push(validation_request.path.dept);
      } else if (validation_request.path.div !== undefined) {
        dept_snap = await db
          .collection(`entities/${validation_request.path.entity}/plans/${validation_request.plan_id}/versions/${validation_request.version_id}/dept`)
          .where("acct", "==", "EXP_WGE")
          .where("div", "==", validation_request.path.div)
          .get();
      } else {
        dept_snap = await db
          .collection(`entities/${validation_request.path.entity}/plans/${validation_request.plan_id}/versions/${validation_request.version_id}/dept`)
          .where("acct", "==", "EXP_WGE")
          .get();
      }

      // add depts to list from query ()
      if (dept_snap !== undefined) {
        for (const dept of dept_snap.docs) {
          const acct_obj = dept.data() as accountDoc;
          if (acct_obj.dept !== undefined && !acct_obj.group) dept_list.push(acct_obj.dept);
        }
      }

      // loop through dept list and build
      const accts_by_dept: laborValidAcctsByDept[] = [];
      for (const valid_dept of dept_list) {
        const acct_snap = await db
          .collection(`entities/${validation_request.path.entity}/plans/${validation_request.plan_id}/versions/${validation_request.version_id}/dept`)
          .where("dept", "==", valid_dept)
          .where("class", "==", "acct")
          .where("parent_rollup.acct", "==", "EXP_WGE")
          .get();

        for (const valid_acct of acct_snap.docs) {
          accts_by_dept.push({ dept_id: valid_dept, acct_id: (valid_acct.data() as accountDoc).acct });
        }
      }

      const labor_response: laborValidationResponse = {
        valid_depts: dept_list,
        valid_accts: accts_by_dept,
      };

      // console.log & return
      console.log(`Completed building valid accounts response2: ${JSON.stringify(labor_response)}`);

      response.json(labor_response).status(200).send();
      //response.status(200).send({ result: `Function completed successfully.` });
    } catch (error) {
      console.log(`Error occured during labor validation request: ${error}`);
      response.sendStatus(500);
    }
  });
});
