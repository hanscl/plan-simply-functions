import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as httpsUtils from '../utils/https_utils';
import * as config from '../config';
import { DeleteVersionRequest } from './delete_version_model';
import { deleteVersionForEntityByName } from './delete_version';

const cors = require('cors')({ origin: true });

const db = admin.firestore();

export const requestDeleteVersion = functions
  .runWith({ timeoutSeconds: 540, memory: '1GB' })
  .region(config.cloudFuncLoc)
  .https.onRequest(async (request, response) => {
    cors(request, response, async () => {
      try {
        response.set('Access-Control-Allow-Origin', '*');
        response.set('Access-Control-Allow-Credentials', 'true');

        if (request.method === 'OPTIONS') {
          response.set('Access-Control-Allow-Methods', 'GET');
          response.set('Access-Control-Allow-Headers', 'Authorization');
          response.set('Access-Control-Max-Age', '3600');
          response.status(204).send('');

          return;
        }

        const authToken = httpsUtils.validateHeader(request); // current user encrypted

        if (!authToken) {
          response.status(403).send('Unauthorized! Missing auth token!');
          return;
        }

        const dec_token = await httpsUtils.decodeAuthToken(authToken);

        if (dec_token === undefined) {
          response.status(403).send('Invalid token.');
          return;
        }

        console.log(`uid: ${dec_token}`);

        const user_snap = await db.doc(`users/${dec_token}`).get();
        if (!user_snap.exists) {
          response.status(403).send('User not known in this system!');
          return;
        }

        const deleteVersionRequest = request.body as DeleteVersionRequest;
        console.log(`Received request: ${JSON.stringify(deleteVersionRequest)}`);

        let query = db.collection(`entities`) as FirebaseFirestore.Query; //.where('type', '==', 'entity');

        if (deleteVersionRequest.entityIds && deleteVersionRequest.entityIds.length > 0) {
          query = query.where(admin.firestore.FieldPath.documentId(), 'in', deleteVersionRequest.entityIds);
        }
        const entityCollectionSnapshot = await query.get();

        for (const entityDoc of entityCollectionSnapshot.docs) {
          console.log(`Deleting version from entity ${entityDoc.id}`);

          await deleteVersionForEntityByName(
            entityDoc.id,
            deleteVersionRequest.planName,
            deleteVersionRequest.versionName
          );
        }
        response.status(200).send({ result: `Delete version from entity or entities completed successfully` });
      } catch (error) {
        console.log(`Error occured while deleting a version: ${error}`);
        response.status(500).send({ result: `Error occured while deleting a version. Please contact support` });
      }
    });
  });
