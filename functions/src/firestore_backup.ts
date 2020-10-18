import * as functions from "firebase-functions";
const key = require("../generator-zerobase-d888b3abeba3.json");

import { google } from "googleapis";

const authClient = new google.auth.JWT({
  email: key.client_email,
  key: key.private_key,
  scopes: ["https://www.googleapis.com/auth/datastore", "https://www.googleapis.com/auth/cloud-platform"],
});

const firestoreClient = google.firestore({
  version: "v1beta2",
  auth: authClient,
});

export const backupFirestore = functions.pubsub
  .schedule("55 17 * * *")
  .timeZone("America/Los_Angeles")
  .onRun(async (context) => {
    //    const projectId = process.env.GCP_PROJECT;
    const fb_config = process.env.FIREBASE_CONFIG;
    if (fb_config === undefined) {
      console.log(`FIREBASE_CONFIG is undefined`);
      return;
    }
    const projectId = JSON.parse(fb_config).projectId;

    console.log(projectId);
    if (projectId?.toLowerCase() !== "generator-zerobase") {
      console.log(`Project ID does not match. No backup will be performed`);
      return;
    } else console.log(`Performing full database backup for ${projectId}.`);

   // const timestamp = new Date().toISOString();

    console.log(`Start to backup project ${projectId}`);

    await authClient.authorize();
    return firestoreClient.projects.databases.exportDocuments({
      name: `projects/${projectId}/databases/(default)`,
      requestBody: {
        outputUriPrefix: `gs://${projectId}-firestore-backups/backups`,
      },
    });
  });
