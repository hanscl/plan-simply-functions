import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as httpsUtils from '../utils/https_utils';
import * as config from '../config';

import { UploadAccountDataRequest } from './upload_model';
import { validateUploadedData } from './validate_data';

const cors = require('cors')({ origin: true });

const db = admin.firestore();

export const validateDataToUploadIntoVersion = functions
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

        const returnResult = await validateUploadedData(uploadDataRequest);
        response.status(200).send(returnResult);
      } catch (error) {
        console.log(`Error occured while validating data: ${error}`);
        response.status(500).send({ result: 'ERROR', message: `Data is not valid for upload: ${error}` });
      }
    });
  });
