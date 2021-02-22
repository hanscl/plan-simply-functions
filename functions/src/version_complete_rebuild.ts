import { rebuildVersionHierarchy } from './version_calc/version_hierarchy_rebuild';
import { versionFullCalc } from './version_calc/version_fullcalc';
import { planViewGenerateCalled } from './plan_view_generate';
import * as httpsUtils from './utils/https_utils';
import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import * as config from './config';
import { dispatchGCloudTask } from './gcloud_task_dispatch';
const cors = require('cors')({ origin: true });

const db = admin.firestore();

interface RebuildRecalcSingleEntity {
  entityId: string;
  planId: string;
  versionId: string;
}

interface RebuildRecalcCloudTaskReq {
  params: RebuildRecalcSingleEntity;
  rebuild: boolean;
}

interface RebuildRecalcMultiEntity {
  planName: string;
  versionName: string;
  entityIds: string[];
}

interface RebuildRecalcRequest {
  action: 'single' | 'multi';
  params: RebuildRecalcMultiEntity | RebuildRecalcSingleEntity;
  rebuild: boolean;
}

export const completeRebuildAndRecalcVersion = async (
  entityPlanVersion: RebuildRecalcSingleEntity,
  rebuild: boolean
) => {
  if (rebuild) {
    await rebuildVersionHierarchy(entityPlanVersion);
    await planViewGenerateCalled(entityPlanVersion);
  }
  await versionFullCalc(entityPlanVersion);
};

export const requestRebuildRecalcVersion = functions
  .runWith({ timeoutSeconds: 540 })
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

        const rebuildRecalcRequest = request.body as RebuildRecalcRequest;

        if (rebuildRecalcRequest.action === 'single') {
          const gctReq: RebuildRecalcCloudTaskReq = {
            rebuild: rebuildRecalcRequest.rebuild,
            params: rebuildRecalcRequest.params as RebuildRecalcSingleEntity,
          };
          await dispatchGCloudTask(gctReq, 'recalc-rebuild-async', 'general');
          response.status(200).send({ result: `Rebuild/Recalc Version - async dispatch completed.` });
        } else {
          // multiple
          const planVersion = rebuildRecalcRequest.params as RebuildRecalcMultiEntity;

          console.log(
            `Version rebuild/recalc requested for multiple entities: [${JSON.stringify(planVersion)}]. Begin async dispatch`
          );

          let query = db.collection(`entities`) as FirebaseFirestore.Query;
          if(planVersion.entityIds && planVersion.entityIds.length > 0) {
            query = query.where(admin.firestore.FieldPath.documentId(), 'in', planVersion.entityIds);
          }
         
          const entityCollectionSnapshot = await query.get();
          console.log(`ENTITY QUERY RESULT: ${entityCollectionSnapshot}`);

          let inSeconds = 0;
          for (const entityDoc of entityCollectionSnapshot.docs) {
            console.log('found entity doc');
            const planSnap = await entityDoc.ref.collection('plans').where('name', '==', planVersion.planName).get();

            for (const planDoc of planSnap.docs) {
              console.log('found plan doc');
              const versionSnap = await planDoc.ref
                .collection('versions')
                .where('name', '==', planVersion.versionName)
                .get();

              for (const versionDoc of versionSnap.docs) {
                console.log(
                  `Dispatching GCT for [recalcRebuildVersionGCT] with entity ${entityDoc.id}, plan ${planDoc.id}, version ${versionDoc.id}`
                );
                const gctReq: RebuildRecalcCloudTaskReq = {
                  rebuild: rebuildRecalcRequest.rebuild,
                  params: { entityId: entityDoc.id, planId: planDoc.id, versionId: versionDoc.id },
                };
                await dispatchGCloudTask(gctReq, 'recalc-rebuild-async', 'general', inSeconds);
                inSeconds += 30;
              }
            }
          }
          response.status(200).send({ result: `Rebuild/Recalc Version - async dispatch completed.` });
        }
      } catch (error) {
        console.log(`Error occured while rebuilding/recalcing version: ${error}`);
        response
          .status(500)
          .send({ result: `Error occured while rebuilding/recalcing version. Please contact support` });
      }
    });
  });

//recalc-rebuild-async
export const recalcRebuildVersionGCT = functions
  .runWith({ timeoutSeconds: 540, memory: '1GB' })
  .region(config.taskQueueLoc)
  .https.onRequest(async (request, response) => {
    try {
      console.log('running [recalcRebuildVersionGCT]');
      // Verify the request
      await httpsUtils.verifyCloudTaskRequest(request, 'recalc-rebuild-async');

      // get the request body
      const rebuildGCTReq = request.body as RebuildRecalcCloudTaskReq;

      console.log(`Running Rebuild/Recalc with parameters: ${JSON.stringify(rebuildGCTReq)}`);

      await completeRebuildAndRecalcVersion(rebuildGCTReq.params, rebuildGCTReq.rebuild);

      response.status(200).send({ result: `recalc/rebuild completed.` });
    } catch (error) {
      console.log(`Error occured while requesting recalcRebuildVersionGCT: ${error}. This should be retried.`);
      response.status(500).send({ result: `Could not execute recalcRebuildVersionGCT. Please contact support` });
    }
  });
