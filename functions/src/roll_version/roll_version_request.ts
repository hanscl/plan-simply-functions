import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as httpsUtils from '../https_utils';
import * as config from '../config';
import { RollVersionRequest } from './roll_version_model';
import { beginRollVersion } from './roll_version';

const cors = require('cors')({ origin: true });

const db = admin.firestore();

export const requestRollVersion = functions.runWith({ timeoutSeconds: 540 }).region(config.cloudFuncLoc).https.onRequest(async (request, response) => {
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

      const rollVersionRequest = request.body as RollVersionRequest;

      await beginRollVersion(rollVersionRequest, true);

      response.status(200).send({ result: `Version has been rolled successfully.` });
    } catch (error) {
      console.log(`Error occured while rolling a version: ${error}`);
      response.status(500).send({ result: `Error occured while rolling a version. Please contact support` });
    }
  });
});
