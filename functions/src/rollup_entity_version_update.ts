import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as entity_model from './entity_model';
import {entityDoc} from './entity_model'
import * as plan_model from './plan_model';
import * as utils from './utils/utils';
import { completeRebuildAndRecalcVersion } from './version_complete_rebuild';
import { taskQueueLoc } from './config';
import { dispatchGCloudTask } from './gcloud_task_dispatch';
import { verifyCloudTaskRequest } from './utils/https_utils';
import { rollingForecastGCT } from './rolling_forecast/rolling_forecast_request'

const db = admin.firestore();

interface ContextParams {
  entityId: string;
  planId: string;
  versionId: string;
}

interface childVersion {
  entity_no: string;
  id: string;
  data: plan_model.versionDoc;
  ref: FirebaseFirestore.DocumentReference;
}

interface EntityPlanVersion {
  entityId: string;
  planId: string;
  versionId: string;
}

interface RollupRecalcParams {
  entityId: string;
  planName: string;
  versionName: string;
}

interface RollupEntityRecalcRequest {
  recalcParams: RollupRecalcParams;
  activeRecalcDocId: string;
}

interface ActiveRecalcDoc {
  entity_id: string;
  plan_name: string;
  version_name: string;
  expires_at: FirebaseFirestore.Timestamp;
}

const calculationDelayInSeconds = 240;

const rebuildAndRecalcRollupEntityVersion = async ({ entityId, planName, versionName }: RollupRecalcParams) => {
  try {
    // const allRollupEntityPlanVersions: EntityPlanVersion[] = [];

    // load child plan and version documents
    // let doc_path = `entities/${contextParams.entityId}`;
    // const entity_snap = await db.doc(doc_path).get();
    // doc_path = `${doc_path}/plans/${contextParams.planId}`;
    // const plan_snap = await db.doc(doc_path).get();
    // doc_path = `${doc_path}/versions/${contextParams.versionId}`;
    // const version_snap = await db.doc(doc_path).get();

    // if (!plan_snap.exists || !version_snap.exists || !entity_snap.exists)
    //   throw new Error(`Could not find entity, plan and/or version documents for entity ${contextParams.entityId}`);

    // const child_entity_plan = plan_snap.data() as plan_model.planDoc;
    // const child_entity_version = version_snap.data() as plan_model.versionDoc;
    // const child_entity = entity_snap.data() as entity_model.entityDoc;

    // create the batch
    let acct_wx_batch = db.batch();
    let acct_wx_ctr = 0;

    // create the empty array for all the version accounts
    const rollup_version_accts: plan_model.accountDoc[] = [];

    // // process all rollup entities
    // for (const rollup_entity_doc of rollup_entities_snap.docs) {
    const rollupEntityDocSnap = await db.doc(`entities/${entityId}`).get();
    if(!rollupEntityDocSnap.exists) {
      throw new Error(`Could not find entity ${entityId} -- this is fatal.`);
    }

    const rollupEntity =  rollupEntityDocSnap.data() as entityDoc;



    // find the matching plan. If it doesn't exists, skip ahead to next rollup entity
    const parentPlanQuerySnap = await rollupEntityDocSnap.ref
        .collection('plans')
        .where('name', '==', planName)
        .get();

    if (parentPlanQuerySnap.empty) {
        console.log(`Parent entity ${entityId} does not have matching plan ${planName}`);
        continue;
      }

      // // TODO: Save plan reference for parent?
      // const rollup_plan_ref = parentPlanQuerySnap.docs[0].ref;

      // check if version already exists => it if does then delete its collections and save the reference
      let existingRollupVersionRef = undefined;
      const parentVersionSnap = await rollupEntityDocSnap.ref
        .collection('versions')
        .where('name', '==', versionName)
        .get();

      if (!parentVersionSnap.empty) {
        existingRollupVersionRef = parentVersionSnap.docs[0].ref;
        for (const coll_id of ['dept', 'div', 'pnl'])
          await utils.deleteCollection(existingRollupVersionRef.collection(coll_id), 300);
      }

      // also get id of default P&L Structure document
      const rollupPnlStructQuerySnap = await rollupEntityDocSnap.ref.collection(`pnl_structures`).where('default', '==', true).get();
      if (rollupPnlStructQuerySnap.empty)
        throw new Error(
          `Rollup entity ${entityId} does not have a default P&L Structure >> Fatal error. Exit function`
        );
      const rollupPnlStructId = rollupPnlStructQuerySnap.docs[0].id;

      const childVersions: childVersion[] = [];
      const childVersionIds: string[] = [];
      const allRollupChildren = rollupEntity.children ? rollupEntity.children : [];

      for (const childEntityId of allRollupChildren) {
        // find the plan for this entity. If any child entity does not have the same plan and version, then we do not create the rollup version either
        const childEntityPlanCollection = `entities/${childEntityId}/plans`;
        const childPlanQuerySnap = await db.collection(childEntityPlanCollection).where('name', '==', planName).get();
        if (childPlanQuerySnap.empty) {
          console.log(
            `Child entity ${childEntityId} does not have a plan named ${planName} >> skipping this child entity`
          );
          continue;
        }

        const childEntityVersionCollection = `${childEntityPlanCollection}/${childPlanQuerySnap.docs[0].id}/versions`;
        const childVersionQuerySnap = await db
          .collection(childEntityVersionCollection)
          .where('name', '==',versionName)
          .get();
    
        if (childVersionQuerySnap.empty) {
          console.log(
            `Child entity ${childEntityId} does not have a version named ${versionName} in plan ${planName} >> skipping this child entity`
          );
          continue;
        }

        // the child does have matching plan and child versions. Also query the entity doc for the number ...
        const childEntityDocSnap = await db.doc(`entities/${childEntityId}`).get();
        if (!childEntityDocSnap.exists)
          throw new Error(
            `Child entity doc for ${childEntityId} not found. This should not be happening and is a fatal error!`
          );
        const childEntityDoc = childEntityDocSnap.data() as entityDoc;

        // add version to list of child versions (and ids again)
        childVersions.push({
          id: childVersionQuerySnap.docs[0].id,
          data: childVersionQuerySnap.docs[0].data() as plan_model.versionDoc,
          ref: childVersionQuerySnap.docs[0].ref,
          entity_no: childEntityDoc.number,
        });
        childVersionIds.push(childVersionQuerySnap.docs[0].id);
      }

      // DB: Create the version doc
      const version_doc: plan_model.versionDoc = {
        last_update: admin.firestore.Timestamp.now(),
        calculated: false,
        ready_for_view: false,
        child_version_ids: childVersionIds,
        name: versionName,
        number: 0,
        pnl_structure_id: rollupPnlStructId,
        is_locked: { all: true, periods: [true, true, true, true, true, true, true, true, true, true, true, true] },
      };

      if (
        child_entity_version.begin_year &&
        child_entity_version.begin_month &&
        child_entity_version.periods &&
        child_entity_version.total
      ) {
        version_doc.begin_year = child_entity_version.begin_year;
        version_doc.begin_month = child_entity_version.begin_month;
        version_doc.periods = child_entity_version.periods;
        version_doc.total = child_entity_version.total;
      }

      // DB: version doc to batch
      if (existingRollupVersionRef === undefined) existingRollupVersionRef = rollup_plan_ref.collection('versions').doc();
      acct_wx_batch.set(existingRollupVersionRef, version_doc);
      acct_wx_ctr++;

      // save the details so we can rebuild/recalc this rollup entity's plan version later
      allRollupEntityPlanVersions.push({
        entityId: rollup_entityId,
        planId: rollup_plan_ref.id,
        versionId: existingRollupVersionRef.id,
      });

      // Process all the plan version of each of the children of this rollup entity
      for (const child_version of childVersions) {
        const child_accts_snap = await child_version.ref.collection('dept').where('class', '==', 'acct').get();

        // Loop through all the n-level accounts of the current child version
        for (const child_acct_doc of child_accts_snap.docs) {
          const child_acct = child_acct_doc.data() as plan_model.accountDoc;

          if (child_acct.dept === undefined)
            throw new Error('Query to child version accts of tupe acct returned acct(s) without dept >> Fatal error.');

          // console.log(
          //   `calling utils.substitute for dept_id ${child_acct.dept}`
          // );
          // fix the dept string using utils.
          const dept_id = utils.substituteEntityForRollup(
            child_acct.dept,
            rollup_entity.entity_embeds,
            rollup_entity.number
          );
          // console.log(`new dept id is ${dept_id}`);

          // End dept conversion

          // build full account string for rollup
          const full_account = utils.buildFullAccountString([rollup_entity.full_account], {
            dept: dept_id,
            acct: child_acct.acct,
            div: child_acct.div,
          });

          // console.log(`new full account is: ${full_account}`);

          // find matching parent account
          const fltrd_rollup_accts = rollup_version_accts.filter((rollup_acct) => {
            return rollup_acct.full_account === full_account;
          });

          // if not parent account, push this child account into array, otherwise add to the parent account we found
          if (fltrd_rollup_accts.length === 0) {
            rollup_version_accts.push({
              ...child_acct,
              dept: dept_id,
              full_account: full_account,
            });
          } else {
            addAccountValues(fltrd_rollup_accts[0], child_acct);
          }
        }

        // DB: all accounts to batch
        for (const acct_obj of rollup_version_accts) {
          acct_wx_batch.set(existingRollupVersionRef.collection('dept').doc(acct_obj.full_account), acct_obj);
          acct_wx_ctr++;
          // intermittent write
          if (acct_wx_ctr > 400) {
            await acct_wx_batch.commit();
            acct_wx_batch = db.batch();
            acct_wx_ctr = 0;
          }
        }
      } // END Child Version Loop
    } // END Rollup Entity Loop
    // Final write
    if (acct_wx_ctr > 0) await acct_wx_batch.commit();

    for (const rollupEntityPlanVersion of allRollupEntityPlanVersions) {
      await completeRebuildAndRecalcVersion(rollupEntityPlanVersion, true);
    }
  } catch (error) {
    console.log(`Error occured while rebuilding rollup entity hierarchy from children: ${error}`);
    return;
  }
};

function addAccountValues(baseAccount: plan_model.accountDoc, newAccount: plan_model.accountDoc) {
  baseAccount.total += newAccount.total;
  for (let idx = 0; idx < baseAccount.values.length; idx++) baseAccount.values[idx] += newAccount.values[idx];
}

// TODO: This needs to be also triggered on new entity create
export const updateRollupEntityVersion = functions
  .runWith({ timeoutSeconds: 540 })
  .firestore.document('entities/{entityId}/plans/{planId}/versions/{versionId}')
  .onUpdate(async (snapshot, context) => {
    try {
      const version_before = snapshot.before.data() as plan_model.versionDoc;
      const version_after = snapshot.after.data() as plan_model.versionDoc;
      const contextParams: ContextParams = {
        entityId: context.params.entityId,
        planId: context.params.planId,
        versionId: context.params.versionId,
      };

      // Process only if the version was recalculated and is ready for view
      // Same as when the version is ready for the view within its own entity
      if (version_after.ready_for_view === false || version_before.ready_for_view === version_after.calculated) {
        console.log(
          `Version ${contextParams.versionId} for entity ${contextParams.entityId} was updated, but state did not change to trigger view build in rollup entity.`
        );
        return;
      }

      console.log(
        `Version ${contextParams.versionId} for entity ${contextParams.entityId} :: State changed >> Update rollup entity versions.`
      );

      // find all entities that this child (modified) entity rolls up to
      const rollup_entities_snap = await db
        .collection(`entities`)
        .where('type', '==', 'rollup')
        .where('children', 'array-contains', contextParams.entityId)
        .get();

      if (rollup_entities_snap.empty) {
        console.log(`No rollup entities have ${contextParams.entityId} as a child`);
        return;
      }

      // Get the plan name and version name that need to be refreshed on the parent entity
      const planSnap = await db.doc(`entities/${contextParams.entityId}/plans/${contextParams.planId}`).get();
      if (!planSnap.exists) {
        throw new Error('Child plan not found -- this should not happen in a trigger function!');
      }
      const planName = (planSnap.data() as plan_model.planDoc).name;
      const versionName = version_after.name;

      for (const parentEntityDoc of rollup_entities_snap.docs) {
        const lastPendingFutureRecalcDocSnap = await db
          .collection(`active_recalcs`)
          .where('expires_at', '>=', admin.firestore.Timestamp.now())
          .orderBy('expires_at', 'desc')
          .limit(1)
          .get();

        let startDateTime = new Date();
        // const recalcExpiresAt = admin.firestore.Timestamp.now()
        if (!lastPendingFutureRecalcDocSnap.empty) {
          const recalcDoc = lastPendingFutureRecalcDocSnap.docs[0].data() as ActiveRecalcDoc;
          startDateTime = recalcDoc.expires_at.toDate();
        }
        const expirationDateTimeInMillis = startDateTime.getTime() + calculationDelayInSeconds * 1000;
        const calcExpiresDoc: ActiveRecalcDoc = {
          entity_id: parentEntityDoc.id,
          plan_name: planName,
          version_name: versionName,
          expires_at: admin.firestore.Timestamp.fromMillis(expirationDateTimeInMillis),
        };

        // save to database
        const writeResult = await db.collection('active_recalcs').add(calcExpiresDoc);
        const inSeconds = Math.max(0, startDateTime.getTime() - new Date().getTime()) * 1000;

        // call GCT
        const gctReq: RollupEntityRecalcRequest = {
          activeRecalcDocId: writeResult.id,
          recalcParams: { entityId: parentEntityDoc.id, planName: planName, versionName: versionName },
        };

        await dispatchGCloudTask(gctReq, 'entity-rollup-version-rebuild-recalc', 'general', inSeconds);
      }
      return Promise.resolve();
    } catch (error) {
      console.log(`Error in trigger function: ${error}`);
      return Promise.reject(error);
    }
  });

//recalc-rebuild-async
export const entityRollupVersionRebuildRecalcGCT = functions
  .runWith({ timeoutSeconds: 540, memory: '1GB' })
  .region(taskQueueLoc)
  .https.onRequest(async (request, response) => {
    try {
      console.log('running [recalcRebuildVersionGCT]');
      // Verify the request
      await verifyCloudTaskRequest(request, 'entity-rollup-version-rebuild-recalc');

      // get the request body
      const entityRollupRebuildRequest = request.body as RollupEntityRecalcRequest;

      console.log(
        `Running Rollup Entity Rebuild/Recalc with parameters: ${JSON.stringify(entityRollupRebuildRequest)}`
      );

      await rebuildAndRecalcRollupEntityVersion(entityRollupRebuildRequest.recalcParams);

      response.status(200).send({ result: `recalc/rebuild completed.` });
    } catch (error) {
      console.log(
        `Error occured while requesting entityRollupVersionRebuildRecalcGCT: ${error}. This should be retried.`
      );
      response
        .status(500)
        .send({ result: `Could not execute entityRollupVersionRebuildRecalcGCT. Please contact support` });
    } finally {
      // get the request body
      const entityRollupRebuildRequest = request.body as RollupEntityRecalcRequest;
      await db.doc(`active_recalcs/${entityRollupRebuildRequest.activeRecalcDocId}`).delete();
    }
  });
