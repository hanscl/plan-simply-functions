import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as https_utils from "./https_utils";
import * as utils from "./utils";
import * as config from "./config";
import * as laborModel from "./labor_model";
import * as laborCalc from "./labor_calc";
import * as entityModel from "./entity_model";
import * as planModel from "./plan_model";
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

      if (laborPosRequest.action === "create" || laborPosRequest.action === "update") {
        await createOrUpdateLaborPosition(laborPosRequest, entityLaborDefs);
      } else if (laborPosRequest.action === "delete" && laborPosRequest.positionId) {
        await deleteLaborPosition(laborPosRequest.entityId, laborPosRequest.versionId, laborPosRequest.positionId);
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

async function deleteLaborPosition(entityId: string, versionId: string, positionId: string) {
  try {
    await db.doc(`entities/${entityId}/labor/${versionId}/positions/${positionId}`).delete();
  } catch (error) {
    throw new Error(`Error in [deleteLaborPosition]: ${error}`);
  }
}

async function createOrUpdateLaborPosition(posReq: laborModel.SavePositionRequest, entityLaborDefs: entityModel.laborCalcs) {
  try {
    if (!posReq.data) throw new Error("No data to create new position");

    // get the days in the month for this plan
    const daysInMonths = await getDaysInMonths(posReq);

    // calculate wages
    const wages = getWages(posReq, entityLaborDefs.wage_method, daysInMonths);
    if (!wages) throw new Error("Unable to calculate wages.");

    // calculate bonus
    const bonus = laborCalc.calculateBonus(posReq.data, wages.values);

    // calculate social security
    const socialsec = laborCalc.calculateSocialSec(posReq.data, wages.values);

    // calculate avg FTEs
    const ftes = laborCalc.calculateAvgFTEs(daysInMonths, posReq.data.ftes);

    // 1. get old values & lock document in tx
    // for (wages, bonus, socialsec)
    // 2. calculate difference
    // 3. schedule cloud task
    // save document & end tx

   // create this comparison -> use cloud task cause this could take a few seconds ...
   await cloudTasks.dispatchGCloudTask({ ...compParams, userId: uid } as compModel.VersionCompWithUser, "process-version-comparison", "general");


    // save document
    savePosition(posReq, wages, bonus, socialsec, ftes);
  } catch (error) {
    throw new Error(`Error in [createLaborPosition]: ${error}`);
  }
}

async function savePosition(
  posReq: laborModel.SavePositionRequest,
  wages: laborModel.laborCalc,
  bonus: laborModel.laborCalc,
  socialsec: laborModel.laborCalc,
  ftes: laborModel.laborCalc
) {
  try {
    if (!posReq.data) throw new Error("Must have position data for saving document");

    // make sure the labor document exists for this version
    const laborDocRef = await createVersionLaborDoc(posReq);

    // create the document
    const laborDoc: laborModel.PositionDoc = {
      acct: posReq.data.acct,
      dept: posReq.data.dept,
      div: await getPositionDiv(posReq.entityId, posReq.data.dept),
      pos: posReq.data.pos,
      wage_type: posReq.data.status,
      fte_factor: posReq.data.fte_factor,
      ftes: ftes,
      rate: laborCalc.calculateRate(posReq.data),
      wages: wages,
      bonus_option: posReq.data.bonus_option,
      bonus_pct: posReq.data.bonus_pct ? posReq.data.bonus_pct : 0,
      bonus: bonus,
      socialsec_pct: posReq.data.socialsec_pct,
      socialsec: socialsec,
      last_updated: admin.firestore.Timestamp.now(),
    };

    // & save
    if (posReq.positionId) {
      await laborDocRef.collection("positions").doc(posReq.positionId).set(laborDoc);
    } else {
      await laborDocRef.collection("positions").add(laborDoc);
    }
  } catch (error) {
    throw new Error(`Error in [savePosition]: ${error}`);
  }
}

async function getPositionDiv(entityId: string, deptId: string): Promise<string> {
  const docPath = `entities/${entityId}/entity_structure/dept`;
  const deptDoc = await db.doc(docPath).get();
  if (!deptDoc.exists) throw new Error(`Dept definition document not found in entity structure: ${docPath}`);

  const deptDict = deptDoc.data() as entityModel.deptDict;

  const divId = deptDict[deptId].div;
  if (!divId) throw new Error(`could not find divID for ${deptId}`);

  return divId;
}

async function createVersionLaborDoc(posReq: laborModel.SavePositionRequest): Promise<FirebaseFirestore.DocumentReference> {
  try {
    const laborDocRef = db.doc(`entities/${posReq.entityId}/labor/${posReq.versionId}`);

    // see if the document exists already
    let versionLaborDoc = await laborDocRef.get();
    if (!versionLaborDoc.exists) {
      await laborDocRef.set({
        plan_id: posReq.planId,
        version_id: posReq.versionId,
      });
    }

    return laborDocRef;
  } catch (error) {
    throw new Error(`Error in [createVersionLaborDoc]`);
  }
}

function getWages(posReq: laborModel.SavePositionRequest, wageMethod: string, daysInMonths: number[]): laborModel.laborCalc | undefined {
  try {
    if (posReq.data === undefined) throw new Error(`Position data is undefined`);

    if (wageMethod === "us") {
      return laborCalc.calculateWagesUS(posReq.data, daysInMonths, posReq.data.ftes);
    } else if (wageMethod === "eu") {
      return laborCalc.calculateWagesEU(posReq.data, posReq.data.ftes);
    } else {
      return undefined;
    }
  } catch (error) {
    throw new Error(`Error occured in [calculateWages]: ${error}`);
  }
}

async function getDaysInMonths(posReq: laborModel.SavePositionRequest): Promise<number[]> {
  const planDoc = await db.doc(`entities/${posReq.entityId}/plans/${posReq.planId}`).get();
  if (!planDoc.exists) throw new Error(`Plan ${posReq.planId} does not exist for entity ${posReq.entityId}`);
  const planData = planDoc.data() as planModel.planDoc;
  const days_in_months = utils.getDaysInMonth(planData.begin_year, planData.begin_month);

  return days_in_months;
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
      if (posReq.data.bonus_option === "Value" && (!posReq.data.bonus || posReq.data.bonus.length !== 12)) throw new Error("Must provide bonus values!");
      if (posReq.data.bonus_option === "Percent" && !posReq.data.bonus_pct) throw new Error("Must provide bonus percentage");
      if (!posReq.data.ftes || posReq.data.ftes.length !== 12) throw new Error("Must provide 12 months of FTEs");
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
