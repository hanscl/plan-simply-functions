import * as functions from 'firebase-functions';
import * as key from "../generator-zerobase-d888b3abeba3.json";

import { google } from "googleapis";


const authClient = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ["https://www.googleapis.com/auth/datastore", "https://www.googleapis.com/auth/cloud-platform"]
});

const firestoreClient = google.firestore({
    version: "v1beta2",
    auth: authClient
});

exports.backupFirestore = functions.pubsub.schedule('every day 00:00').onRun(async (context) => {
    const projectId = process.env.GCP_PROJECT

    const timestamp = new Date().toISOString()

    console.log(`Start to backup project ${projectId}`)

    await authClient.authorize();
    return firestoreClient.projects.databases.exportDocuments({
        name: `projects/${projectId}/databases/(default)`,
        requestBody: {
            outputUriPrefix: `gs://${projectId}-firestore-backups/backups/${timestamp}`
        }
    })

});