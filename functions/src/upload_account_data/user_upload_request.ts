import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as httpsUtils from '../utils/https_utils';
import * as config from '../config';

import { UploadAccountDataRequest, UploadTemplateRequest } from './upload_model';
import { insertDataIntoVersion } from './insert_data_into_version';
import { dispatchGCloudTask } from '../gcloud_task_dispatch';

const cors = require('cors')({ origin: true });

const db = admin.firestore();

export const requestUploadDataToVersion = functions
  .runWith({ timeoutSeconds: 360 })
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

        const uploadDataRequest = request.body as UploadAccountDataRequest;

        await insertDataIntoVersion(uploadDataRequest);

        const { entityId, planId, versionId } = uploadDataRequest;

        const uploadReqGCT: UploadTemplateRequest = { entityId: entityId, planId: planId, versionId: versionId };

        // schedule the cloud task
        await dispatchGCloudTask(uploadReqGCT, 'version-fullcalc-async', 'general');
        
        response.status(200).send({
          status: 'OK',
          message: 'Data uploaded successfully. Version calculation will be completed within 1-2 minutes',
        });
      } catch (error) {
        console.log(`Error occured while processing data upload: ${error}`);
        response.status(500).send({ status: 'ERROR', message: `Unable to upload data: ${error}` });
      }
    });
  });
