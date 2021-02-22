import * as functions from "firebase-functions";
import * as admin from 'firebase-admin';
import * as config from '../config';

const db = admin.firestore()

export const backupFirestore = functions.pubsub
  .schedule("55 21 * * *")
  .timeZone("America/Los_Angeles")
  .onRun(async (context) => {
   
    const 

    const timestamp = new Date().toISOString();

    console.log(`Start to backup project ${projectId}`);

   
    return firestoreClient.projects.databases.exportDocuments({
      name: `projects/${projectId}/databases/(default)`,
      requestBody: {
        outputUriPrefix: `gs://${projectId}-firestore-backup/backups/${timestamp}`,
      },
    });
  });