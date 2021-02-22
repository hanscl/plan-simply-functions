import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { entityDoc } from './entity_model';
import * as plan_model from './plan_model';
import * as utils from './utils/utils';
import { completeRebuildAndRecalcVersion } from './version_complete_rebuild';
import { taskQueueLoc } from './config';
import { dispatchGCloudTask } from './gcloud_task_dispatch';
import { verifyCloudTaskRequest } from './utils/https_utils';

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

const calculationDelayInSeconds = 120;

const rebuildAndRecalcRollupEntityVersion = async (entityId: string, planName: string, versionName: string) => {
  try {
    // create the batch
    let acct_wx_batch = db.batch();
    let acct_wx_ctr = 0;

    // create the empty array for all the version accounts
    const rollup_version_accts: plan_model.accountDoc[] = [];

    console.log(`ENTITY ID: ${entityId} - PLAN NAME: ${planName} - VERSION NAME: ${versionName}`);

    // // process all rollup entities
    // for (const rollup_entity_doc of rollup_entities_snap.docs) {
    const rollupEntityDocSnap = await db.doc(`entities/${entityId}`).get();
    if (!rollupEntityDocSnap.exists) {
      throw new Error(`Could not find entity ${entityId} -- this is fatal.`);
    }

    const rollupEntity = rollupEntityDocSnap.data() as entityDoc;

    // find the matching plan. If it doesn't exists, skip ahead to next rollup entity
    const parentPlanQuerySnap = await rollupEntityDocSnap.ref.collection('plans').where('name', '==', planName).get();

    if (parentPlanQuerySnap.empty) {
      console.log(`Parent entity ${entityId} does not have matching plan ${planName}`);
      return;
    }

    const planId = parentPlanQuerySnap.docs[0].id;

    // check if version already exists => it if does then delete its collections and save the reference
    let existingRollupVersionRef = undefined;
    const parentVersionSnap = await parentPlanQuerySnap.docs[0].ref
      .collection('versions')
      .where('name', '==', versionName)
      .get();

    if (!parentVersionSnap.empty) {
      console.log(`found version for rollup entity: ${parentVersionSnap.docs[0].id}`);
      existingRollupVersionRef = parentVersionSnap.docs[0].ref;
      for (const coll_id of ['dept', 'div', 'pnl'])
        await utils.deleteCollection(existingRollupVersionRef.collection(coll_id), 300);
    }

    // also get id of default P&L Structure document
    const rollupPnlStructQuerySnap = await rollupEntityDocSnap.ref
      .collection(`pnl_structures`)
      .where('default', '==', true)
      .get();
    if (rollupPnlStructQuerySnap.empty)
      throw new Error(`Rollup entity ${entityId} does not have a default P&L Structure >> Fatal error. Exit function`);
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
        .where('name', '==', versionName)
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

    // make sure we have at least 1 child version
    if (childVersions.length === 0) {
      throw new Error(`no child with matching plan/versions found for this rollup`);
    }

    // get the highest version number for this entity's plan-versions
    let versionNumber = 0;
    const versionNumberQuerySnap = await parentPlanQuerySnap.docs[0].ref
      .collection('versions')
      .orderBy('number', 'desc')
      .limit(1)
      .get();
    if (!versionNumberQuerySnap.empty) {
      versionNumber = (versionNumberQuerySnap.docs[0].data() as plan_model.versionDoc).number + 1;
    }

    // DB: Create the version doc
    const version_doc: plan_model.versionDoc = {
      last_update: admin.firestore.Timestamp.now(),
      calculated: false,
      ready_for_view: false,
      child_version_ids: childVersionIds,
      name: versionName,
      number: versionNumber,
      // ASSIGN CALENDAR FROM FIRST VERSION: TODO => THIS IS NOT IDEAL, ASSUMES CONSISTENCY OF ALL CHILD VERSIONS
      begin_year: childVersions[0].data.begin_year,
      begin_month: childVersions[0].data.begin_month,
      periods: childVersions[0].data.periods,
      total: childVersions[0].data.total,
      pnl_structure_id: rollupPnlStructId,
      is_locked: { all: true, periods: [true, true, true, true, true, true, true, true, true, true, true, true] },
    };

    // DB: version doc to batch
    if (existingRollupVersionRef === undefined) {
      console.log(`creating new version for rollup entity ..`);
      existingRollupVersionRef = rollupEntityDocSnap.ref.collection('versions').doc();
    }
    const versionId = existingRollupVersionRef.id;
    acct_wx_batch.set(existingRollupVersionRef, version_doc);
    acct_wx_ctr++;

    // Process all the plan version of each of the children of this rollup entity
    for (const child_version of childVersions) {
      const child_accts_snap = await child_version.ref.collection('dept').where('class', '==', 'acct').get();
      console.log(`found ${child_accts_snap.docs.length} child accounts`);

      // Loop through all the n-level accounts of the current child version
      for (const child_acct_doc of child_accts_snap.docs) {
        const child_acct = child_acct_doc.data() as plan_model.accountDoc;  
        console.log(`Processing child account: ${JSON.stringify(child_acct)}`);

        if (child_acct.dept === undefined)
          throw new Error('Query to child version accts of tupe acct returned acct(s) without dept >> Fatal error.');

        // fix the dept string using utils.
        const dept_id = utils.substituteEntityForRollup(
          child_acct.dept,
          rollupEntity.entity_embeds,
          rollupEntity.number
        );

        // build full account string for rollup
        const full_account = utils.buildFullAccountString([rollupEntity.full_account], {
          dept: dept_id,
          acct: child_acct.acct,
          div: child_acct.div,
        });

        console.log(`build full account:  ${full_account}`);

        // find matching parent account
        const fltrd_rollup_accts = rollup_version_accts.filter((rollup_acct) => {
          return rollup_acct.full_account === full_account;
        });

        // if not parent account, push this child account into array, otherwise add to the parent account we found
        if (fltrd_rollup_accts.length === 0) {
          console.log(`account ${child_acct.full_account} not yet in parent account array; add now ...`);
          rollup_version_accts.push({
            ...child_acct,
            dept: dept_id,
            full_account: full_account,
          });
        } else {
          console.log(`adding account values for  ${child_acct.full_account} to parent`);
          addAccountValues(fltrd_rollup_accts[0], child_acct);
        }


      console.log(`parent account array after addition: ${JSON.stringify(rollup_version_accts)}`);
      
      }


      // DB: all accounts to batch
      for (const acct_obj of rollup_version_accts) {
        console.log(`adding accrt ${JSON.stringify(acct_obj)} to batch`);
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

    // Final write
    if (acct_wx_ctr > 0) {
      await acct_wx_batch.commit();
    }
    console.log(`Triggering rebuild/recalc for rollup plan version: ${entityId} - ${planId} - ${versionId}`);
    await completeRebuildAndRecalcVersion({ entityId: entityId, planId: planId, versionId: versionId }, true);
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

        let startDateTime = new Date(new Date().getTime() + 120000);
        // const recalcExpiresAt = admin.firestore.Timestamp.now()
        if (!lastPendingFutureRecalcDocSnap.empty) {
          const recalcDoc = lastPendingFutureRecalcDocSnap.docs[0].data() as ActiveRecalcDoc;
          const lastExpiryrecalcDoc = recalcDoc.expires_at.toDate();
          console.log(`found recalc for this entity, which is expiring at ${JSON.stringify(lastExpiryrecalcDoc)}`)
          if (lastExpiryrecalcDoc.getTime() > new Date().getTime()) {
            startDateTime = recalcDoc.expires_at.toDate();
            console.log(`last recalc is expiring in the future; use this for our new calc: ${JSON.stringify(startDateTime)}`)
          }
        }
        const expirationDateTimeInMillis = startDateTime.getTime() + calculationDelayInSeconds * 1000;
        const calcExpiresDoc: ActiveRecalcDoc = {
          entity_id: parentEntityDoc.id,
          plan_name: planName,
          version_name: versionName,
          expires_at: admin.firestore.Timestamp.fromMillis(expirationDateTimeInMillis),
        };

        console.log(`Adding expiration doc to database: ${JSON.stringify(calcExpiresDoc)}`);
        // save to database
        const writeResult = await db.collection('active_recalcs').add(calcExpiresDoc);
        console.log(`Write Result is: ${JSON.stringify(writeResult)}`);
        const startDiffInMillis = startDateTime.getTime() - (new Date().getTime());
        const inSeconds = Math.max(120000, startDiffInMillis) / 1000;

        console.log(
          `Dispatching entity rollup recalc in ${inSeconds} seconds (${startDiffInMillis} millis) for ${parentEntityDoc.id}, ${planName}, ${versionName}`
        );
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

//entity-rollup-version-rebuild-recalc
export const entityRollupVersionRebuildRecalcGCT = functions
  .runWith({ timeoutSeconds: 540, memory: '1GB' })
  .region(taskQueueLoc)
  .https.onRequest(async (request, response) => {
    try {
      console.log('running [entityRollupVersionRebuildRecalcGCT]');
      // Verify the request
      await verifyCloudTaskRequest(request, 'entity-rollup-version-rebuild-recalc');

      // get the request body
      const entityRollupRebuildRequest = request.body as RollupEntityRecalcRequest;

      console.log(
        `Running Rollup Entity Rebuild/Recalc with parameters: ${JSON.stringify(entityRollupRebuildRequest)}`
      );

      const { entityId, planName, versionName } = entityRollupRebuildRequest.recalcParams;
      await rebuildAndRecalcRollupEntityVersion(entityId, planName, versionName);

      await db.doc(`active_recalcs/${entityRollupRebuildRequest.activeRecalcDocId}`).delete();
      response.status(200).send({ result: `recalc/rebuild completed.` });
    } catch (error) {
      const entityRollupRebuildRequest = request.body as RollupEntityRecalcRequest;
      await db.doc(`active_recalcs/${entityRollupRebuildRequest.activeRecalcDocId}`).delete();
      console.log(
        `Error occured while requesting entityRollupVersionRebuildRecalcGCT: ${error}. This should be retried.`
      );
      response
        .status(500)
        .send({ result: `Could not execute entityRollupVersionRebuildRecalcGCT. Please contact support` });
      }
    // } finally {
    //   // get the request body
    //   const entityRollupRebuildRequest = request.body as RollupEntityRecalcRequest;
    //   await db.doc(`active_recalcs/${entityRollupRebuildRequest.activeRecalcDocId}`).delete();
    // }
  });
