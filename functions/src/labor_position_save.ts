import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as https_utils from "./https_utils";
import * as config from "./config";
import * as laborModel from "./labor_model";
import * as laborCalc from "./labor_calc";
import * as entityModel from "./entity_model";
//import * as cloudTasks from "./gcloud_task_dispatch";

const cors = require("cors")({ origin: true });

const db = admin.firestore();

export const laborPositionRequest = functions.region(config.cloudFuncLoc).https.onRequest(async (request, response) => {
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

      const uid = await https_utils.decodeAuthToken(authToken);

      if (uid === undefined) {
        response.status(403).send("Invalid token.");
        return;
      }

      console.log(`uid: ${uid}`);
      console.log(`Cloud Function Deploy Location: ${config.cloudFuncLoc}`);

      const user_snap = await db.doc(`users/${uid}`).get();
      if (!user_snap.exists) {
        response.status(403).send("User not known in this system!");
        return;
      }

      const laborPosRequest = request.body as laborModel.SavePositionRequest;

      // make sure the request is valid. This will throw an error if it is not.
      checkRequestIsValid(laborPosRequest);

      // Get the labor calcs object from the entity
      const entityDoc = await db.doc(`entities/${laborPosRequest.entityId}`).get();
      if (!entityDoc.exists) throw new Error(`Entity document not found for ${laborPosRequest.entityId}`);
      const entityLaborDefs = entityDoc.data() as entityModel.laborCalcs;

      checkEntityLaborDefs(entityLaborDefs);

      if (laborPosRequest.action === "create") {
        await createLaborPosition(laborPosRequest, entityLaborDefs);
      } else if (laborPosRequest.action === "update") {
        await updateLaborPosition(laborPosRequest);
      } else if (laborPosRequest.action === "delete") {
        await deleteLaborPosition(laborPosRequest);
      } else
        throw new Error(
          `Unable to process request to save Labor position. Invalid action specified: '${laborPosRequest.action}'. Valid actions are 'create', 'update', 'save'`
        );

      response.status(200).send({ result: `Labor position request processed successfully.` });

      return Promise.resolve();
    } catch (error) {
      console.log(`Error occured while saving/deleting labor position: ${error}`);
      response.status(500).send({ result: `Error occured while trying to save/delete position. Please contact support` });
      return Promise.reject(new Error("Error occured while saving/deleting labor position."));
    }
  });
});

async function createLaborPosition(posReq: laborModel.SavePositionRequest, entityLaborDefs: entityModel.laborCalcs) {
  try {
    // calculate wages
    let wages = undefined;
    const wages = () => {

    }

    if(entityLaborDefs.wage_method === "eu") 

    const wages = laborCalc.calculateWagesEU();
    // calculate bonus

    // calculate social security

    // save document
  } catch (error) {
    throw new Error(`Error in [createLaborPosition]: ${error}`);
  }
}

function checkRequestIsValid(posReq: laborModel.SavePositionRequest) {
  try {
    if (!posReq.entityId || !posReq.versionId) throw new Error("Invalid request. Require both Entity and Version Id");

    if (!posReq.positionId && posReq.action !== "create") throw new Error("Invalid request. Position ID required for updated and deletes.");

    // data object validations are only required for create and update requests
    if (posReq.action !== "delete") {
      if (!posReq.data) throw new Error("Position data required for update and create requests.");
      if (!posReq.data.acct || !posReq.data.dept || !posReq.data.pos) throw new Error("Acct/Dept/Title are required for update and create requests.");
      if (posReq.data.status !== "Hourly" && posReq.data.status !== "Salary") throw new Error("Invalid Wage Type. Must be Hourly or Salary.");
      if (!posReq.data.rate.annual && !posReq.data.rate.hourly) throw new Error("Must provide pay rate.");
      if (!(posReq.data.bonus_option in ["None", "Percent", "Value"])) throw new Error("Invalid Bonus option. Must be None, Percent or Value");
      if (posReq.data.bonus_option === "Value" && !posReq.data.bonus) throw new Error("Must provide bonus values!");
    }
  } catch (error) {
    throw new Error(`Invalid request to save labor: ${error}`);
  }
}

function checkEntityLaborDefs(entityLabor: entityModel.laborCalcs) {
  try {
    if (!entityLabor.wage_method || !["us", "eu"].includes(entityLabor.wage_method)) throw new Error("No valid wage method defined for entity");
    if (!entityLabor.default_accts || !entityLabor.default_accts.bonus || !entityLabor.default_accts.socialsec)
      throw new Error("Missing required default accounts for bonus and social security calculation");
  } catch (error) {
    throw new Error(`Error occured in [checkEntityLaborCalcs]: ${error}`);
  }
}

export interface savePositionRequest {
  action: "create" | "update" | "delete";
  id?: string; //firstore document id
  data?: {
    acct: string;
    dept: string;
    pos: string;
    status: "Salary" | "Hourly";
    rate: { annual?: number; hourly?: number };
    fte_factor: number;
    bonus_option: "None" | "Percent" | "Value";
    bonus?: laborCalc;
    socialsec_pct: number;
  };
}
