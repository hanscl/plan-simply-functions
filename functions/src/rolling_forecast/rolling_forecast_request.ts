import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as httpsUtils from '../utils/https_utils';
import * as config from '../config';

import { RollingForecastForEntity, RollingForecastRequest } from './rolling_forecast_model';
import { beginRollingForecast } from './rolling_forecast';
import { dispatchGCloudTask } from '../gcloud_task_dispatch';

const cors = require('cors')({ origin: true });

const db = admin.firestore();

export const requestRollForecast = functions
  .region(config.cloudFuncLoc)
  .runWith({ timeoutSeconds: 540, memory: '1GB' })
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

        const rollingForecastRequest = request.body as RollingForecastRequest;
        console.log(`Received request: ${JSON.stringify(rollingForecastRequest)}`);

        let query = db.collection(`entities`).where('type', '==', 'entity');

        if (rollingForecastRequest.entityIds && rollingForecastRequest.entityIds.length > 0) {
          query = query.where(admin.firestore.FieldPath.documentId(), 'in', rollingForecastRequest.entityIds);
        }
        
        const entityCollectionSnapshot = await query.get();

        let inSeconds = 0;
        for (const entityDoc of entityCollectionSnapshot.docs) {
          console.log(`Dispatching GCT for [rollingForecastGCT] and entity ${entityDoc.id}`);

          const { planName, sourceVersionName, targetVersionName, seedMonth } = rollingForecastRequest;

          const rollFcstReqGCT: RollingForecastForEntity = {
            planName: planName,
            sourceVersionName: sourceVersionName,
            targetVersionName: targetVersionName,
            seedMonth: seedMonth,
            entityId: entityDoc.id,
          };

          await dispatchGCloudTask(rollFcstReqGCT, 'rolling-forecast-async', 'general', inSeconds);
          inSeconds += 30;
        }
        response.status(200).send({ result: `Tasks for rolling forecasts have been scheduled.` });
      } catch (error) {
        console.log(`Error occured while rolling forecast month: ${error}`);
        response.status(500).send({ result: `Error occured while rolling forecast month. Please contact support` });
      }
    });
  });

//rolling-forecast-async
export const rollingForecastGCT = functions
  .runWith({ timeoutSeconds: 540, memory: '1GB' })
  .region(config.taskQueueLoc)
  .https.onRequest(async (request, response) => {
    try {
      console.log('running [rollingForecastGCT]');
      // Verify the request
      await httpsUtils.verifyCloudTaskRequest(request, 'rolling-forecast-async');

      // get the request body
      const rollFcstReq = request.body as RollingForecastForEntity;

      console.log(`Running rollingForecastGCT with parameters: ${JSON.stringify(rollFcstReq)}`);

      await beginRollingForecast(rollFcstReq);

      response.status(200).send({ result: `rolling forecast completed.` });
    } catch (error) {
      console.log(`Error occured while requesting rollingForecastGCT: ${error}. This should be retried.`);
      response.status(500).send({ result: `Could not execute rollingForecastGCT. Please contact support` });
    }
  });
