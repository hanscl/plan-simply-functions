import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as entity_model from './entity_model';
import * as plan_model from './plan_model';
import * as utils from './utils/utils';
import { completeRebuildAndRecalcVersion } from './version_complete_rebuild';

const db = admin.firestore();

interface contextParams {
  entity_id: string;
  plan_id: string;
  version_id: string;
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

// TODO: This needs to be also triggered on new entity create
export const updateRollupEntityVersion = functions
  .runWith({ timeoutSeconds: 540 })
  .firestore.document('entities/{entityId}/plans/{planId}/versions/{versionId}')
  .onUpdate(async (snapshot, context) => {
    try {
      const version_before = snapshot.before.data() as plan_model.versionDoc;
      const version_after = snapshot.after.data() as plan_model.versionDoc;
      const context_params: contextParams = {
        entity_id: context.params.entityId,
        plan_id: context.params.planId,
        version_id: context.params.versionId,
      };

      // Process only if the version was recalculated and is ready for view
      // Same as when the version is ready for the view within its own entity
      if (version_after.ready_for_view === false || version_before.ready_for_view === version_after.calculated) {
        console.log(
          `Version ${context_params.version_id} for entity ${context_params.entity_id} was updated, but state did not change to trigger view build in rollup entity.`
        );
        return;
      }

      console.log(
        `Version ${context_params.version_id} for entity ${context_params.entity_id} :: State changed >> Update rollup entity versions.`
      );

      const allRollupEntityPlanVersions: EntityPlanVersion[] = [];

      // find all entities that this entity rolls up to
      const rollup_entities_snap = await db
        .collection(`entities`)
        .where('type', '==', 'rollup')
        .where('children', 'array-contains', context_params.entity_id)
        .get();

      if (rollup_entities_snap.empty) {
        console.log(`No rollup entities have ${context_params.entity_id} as a child`);
        return;
      }

      // load child plan and version documents
      let doc_path = `entities/${context_params.entity_id}`;
      const entity_snap = await db.doc(doc_path).get();
      doc_path = `${doc_path}/plans/${context_params.plan_id}`;
      const plan_snap = await db.doc(doc_path).get();
      doc_path = `${doc_path}/versions/${context_params.version_id}`;
      const version_snap = await db.doc(doc_path).get();

      if (!plan_snap.exists || !version_snap.exists || !entity_snap.exists)
        throw new Error(`Could not find entity, plan and/or version documents for entity ${context_params.entity_id}`);

      const child_entity_plan = plan_snap.data() as plan_model.planDoc;
      const child_entity_version = version_snap.data() as plan_model.versionDoc;
      const child_entity = entity_snap.data() as entity_model.entityDoc;

      // create the batch
      let acct_wx_batch = db.batch();
      let acct_wx_ctr = 0;

      // create the empty array for all the version accounts
      const rollup_version_accts: plan_model.accountDoc[] = [];

      // process all rollup entities
      for (const rollup_entity_doc of rollup_entities_snap.docs) {
        const rollup_entity_ref = rollup_entity_doc.ref;
        const rollup_entity_id = rollup_entity_doc.id;
        const rollup_entity = rollup_entity_doc.data() as entity_model.entityDoc;

        if (rollup_entity.children === undefined) continue;

        // find the matching plan. If it doesn't exists, skip ahead to next rollup entity
        const prnt_plan_snap = await rollup_entity_ref
          .collection('plans')
          .where('name', '==', child_entity_plan.name)
          .get();
        if (prnt_plan_snap.empty) {
          console.log(`Parent entity ${rollup_entity_id} does not have matching plan ${child_entity_plan.name}`);
          continue;
        }

        // TODO: Save plan reference for parent?
        const rollup_plan_ref = prnt_plan_snap.docs[0].ref;

        // check if version already exists => it if does then delete its collections and save the reference
        let rollup_version_ref = undefined;
        const prnt_version_snap = await rollup_plan_ref
          .collection('versions')
          .where('name', '==', child_entity_version.name)
          .get();

        if (!prnt_version_snap.empty) {
          rollup_version_ref = prnt_version_snap.docs[0].ref;
          for (const coll_id of ['dept', 'div', 'pnl'])
            await utils.deleteCollection(rollup_version_ref.collection(coll_id), 300);
        }

        // also get id of default P&L Structure document
        const rollup_pnl_snap = await rollup_entity_ref.collection(`pnl_structures`).where('default', '==', true).get();
        if (rollup_pnl_snap.empty)
          throw new Error(
            `Rollup entity ${rollup_entity_id} does not have a default P&L Structure >> Fatal error. Exit function`
          );
        const rollup_pnl_struct_id = rollup_pnl_snap.docs[0].id;

        // push the initial version doc into an array of child_versions
        const child_versions: childVersion[] = [
          {
            id: version_snap.id,
            data: child_entity_version,
            ref: version_snap.ref,
            entity_no: child_entity.number,
          },
        ];
        const child_version_ids: string[] = [version_snap.id];
        for (const chld_entity_id of rollup_entity.children) {
          // do not requery plan of the child that triggered this function
          if (chld_entity_id === context_params.entity_id) continue;

          // find the plan for this entity. If any child entity does not have the same plan and version, then we do not create the rollup version either
          let chld_coll_path = `entities/${chld_entity_id}/plans`;
          const chld_plan_snap = await db.collection(chld_coll_path).where('name', '==', child_entity_plan.name).get();
          if (chld_plan_snap.empty) {
            console.log(
              `Child entity ${chld_entity_id} does not have a plan named ${child_entity_plan.name} >> No rollup will be created`
            );
            return;
          }
          chld_coll_path = `${chld_coll_path}/${chld_plan_snap.docs[0].id}/versions`;
          const chld_version_snap = await db
            .collection(chld_coll_path)
            .where('name', '==', child_entity_version.name)
            .get();
          if (chld_version_snap.empty) {
            console.log(
              `Child entity ${chld_entity_id} does not have a version named ${child_entity_version.name} in plan ${child_entity_plan.name} >> No rollup will be created`
            );
            return;
          }

          // the child does have matching plan and child versions. Also query the entity doc for the number ...
          const chld_entity_snap = await db.doc(`entities/${chld_entity_id}`).get();
          if (!chld_entity_snap.exists)
            throw new Error(
              `Child entity doc for ${chld_entity_id} not found. This should not be happening and is a fatal error!`
            );
          const chld_entity = chld_entity_snap.data() as entity_model.entityDoc;

          // add version to list of child versions (and ids again)
          child_versions.push({
            id: chld_version_snap.docs[0].id,
            data: chld_version_snap.docs[0].data() as plan_model.versionDoc,
            ref: chld_version_snap.docs[0].ref,
            entity_no: chld_entity.number,
          });
          child_version_ids.push(chld_version_snap.docs[0].id);
        }

        console.log(
          `All children of entity ${rollup_entity_id} have a version named ${child_entity_version.name} in plan ${child_entity_plan.name} >> Proceed with updating rollup version`
        );
        // console.log(
        //   `Here are the version data we are using: ${JSON.stringify(
        //     child_versions
        //   )}`
        // );

        // DB: Create the version doc
        const version_doc: plan_model.versionDoc = {
          last_update: admin.firestore.Timestamp.now(),
          calculated: false,
          ready_for_view: false,
          child_version_ids: child_version_ids,
          name: child_entity_version.name,
          number: 0,
          pnl_structure_id: rollup_pnl_struct_id,
          is_locked: { all: true, periods: [true, true, true, true, true, true, true, true, true, true, true, true] },
        };

        // DB: version doc to batch
        if (rollup_version_ref === undefined) rollup_version_ref = rollup_plan_ref.collection('versions').doc();
        acct_wx_batch.set(rollup_version_ref, version_doc);
        acct_wx_ctr++;

        // save the details so we can rebuild/recalc this rollup entity's plan version later
        allRollupEntityPlanVersions.push({
          entityId: rollup_entity_id,
          planId: rollup_plan_ref.id,
          versionId: rollup_version_ref.id,
        });

        // Process all the plan version of each of the children of this rollup entity
        for (const child_version of child_versions) {
          const child_accts_snap = await child_version.ref.collection('dept').where('class', '==', 'acct').get();

          // Loop through all the n-level accounts of the current child version
          for (const child_acct_doc of child_accts_snap.docs) {
            const child_acct = child_acct_doc.data() as plan_model.accountDoc;

            if (child_acct.dept === undefined)
              throw new Error(
                'Query to child version accts of tupe acct returned acct(s) without dept >> Fatal error.'
              );

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
            acct_wx_batch.set(rollup_version_ref.collection('dept').doc(acct_obj.full_account), acct_obj);
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
        await completeRebuildAndRecalcVersion(rollupEntityPlanVersion);
      }
    } catch (error) {
      console.log(`Error occured while rebuilding rollup entity hierarchy from children: ${error}`);
      return;
    }
  });

function addAccountValues(baseAccount: plan_model.accountDoc, newAccount: plan_model.accountDoc) {
  // add total
  // console.log(
  //   `adding accounts. BASE ACCOUNT: Total before: ${
  //     baseAccount.total
  //   } -- Values before: ${JSON.stringify(baseAccount.values)}`
  // );
  // console.log(
  //   `adding accounts. NEW ACCOUNT: Total before: ${
  //     newAccount.total
  //   } -- Values before: ${JSON.stringify(newAccount.values)}`
  // );
  baseAccount.total += newAccount.total;
  for (let idx = 0; idx < baseAccount.values.length; idx++) baseAccount.values[idx] += newAccount.values[idx];
  // console.log(
  //   `added accounts. Total after: ${
  //     baseAccount.total
  //   } -- Values after: ${JSON.stringify(baseAccount.values)}`
  // );
}
