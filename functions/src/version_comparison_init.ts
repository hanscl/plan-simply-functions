import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as https_utils from "./https_utils";
import * as config from "./config";
import * as cloudTasks from "./gcloud_task_dispatch";
import * as compModel from "./version_comparison_model";
import * as compCreate from "./version_comparison_create";

const cors = require("cors")({ origin: true });

const db = admin.firestore();

export const initVersionComparison = functions.region(config.cloudFuncLoc).https.onRequest(async (request, response) => {
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

      const compParams = request.body as compModel.VersionComp;

      // see if comparison already exists
      const compareSnap = await db.doc(`comps/${compParams.compareVersion.versionId}/base_versions/${compParams.baseVersion.versionId}`).get();
      if (!compareSnap.exists) {
        // create this comparison -> use cloud task cause this could take a few seconds ...
        await cloudTasks.dispatchGCloudTask({ ...compParams, uid: uid }, "process-version-comparison", "general");

        response.status(200).send({ result: `Initializing Version Comparison ...` });
      } else {
        response.status(200).send({ result: `Version Comparison ready.` });
      }
      return Promise.resolve();
    } catch (error) {
      console.log(`Error occured while requesting version comparison: ${error}`);
      response.status(500).send({ result: `Request to initialize version comparison failed. Please contact support` });
      return Promise.reject(new Error("Version Comparison Initialization Failed."));
    }
  });
});

export const processVersionComparison = functions.region(config.cloudFuncLoc).https.onRequest(async (request, response) => {
  try {
    // Verify the request 
    await https_utils.verifyCloudTaskRequest(request, "process-version-comparison");
    
    // get the request body
    const versionCompParams = request.body as compModel.VersionCompWithUser;

    console.log(`Running processVersionComparison with parameters: ${JSON.stringify(versionCompParams)}`)
    await compCreate.createVersionComparison(versionCompParams);

    response.status(200).send({ result: `Version Comparison ready.` });
  } catch (error) {
    console.log(`Error occured while initializing version comparison: ${error}`);
    response.status(500).send({ result: `Could not initialize version comparison. Please contact support` });
  }
});
