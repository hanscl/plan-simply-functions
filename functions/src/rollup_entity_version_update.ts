import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as entity_model from "./entity_model";
import * as plan_model from "./plan_model";

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

// TODO: This needs to be also triggered on new entity create
export const updateRollupEntityVersion = functions.firestore
  .document("entities/{entityId}/plans/{planId}/versions/{versionId}")
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
      if (
        version_after.ready_for_view === false ||
        version_before.ready_for_view === version_after.calculated
      ) {
        console.log(
          `Version ${context_params.version_id} for entity ${context_params.entity_id} was updated, but state did not change to trigger view build in rollup entity.`
        );
        return;
      }

      console.log(
        `Version ${context_params.version_id} for entity ${context_params.entity_id} :: State changed >> Update rollup entity versions.`
      );

      // find all entities that this entity rolls up to
      const rollup_entities_snap = await db
        .collection(`entities`)
        .where("type", "==", "rollup")
        .where("children", "array-contains", context_params.entity_id)
        .get();

      if (rollup_entities_snap.empty) {
        console.log(
          `No rollup entities have ${context_params.entity_id} as a child`
        );
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
        throw new Error(
          `Could not find entity, plan and/or version documents for entity ${context_params.entity_id}`
        );

      const child_entity_plan = plan_snap.data() as plan_model.planDoc;
      const child_entity_version = version_snap.data() as plan_model.versionDoc;
      const child_entity = entity_snap.data() as entity_model.entityDoc;

      // process all rollup entities
      for (const rollup_entity_doc of rollup_entities_snap.docs) {
        const rollup_entity_ref = rollup_entity_doc.ref;
        const rollup_entity_id = rollup_entity_doc.id;
        const rollup_entity = rollup_entity_doc.data() as entity_model.entityDoc;

        if (rollup_entity.children === undefined) continue;

        // find the matching plan. If it doesn't exists, skip ahead to next rollup entity
        const prnt_plan_snap = await rollup_entity_ref
          .collection("plans")
          .where("name", "==", child_entity_plan.name)
          .get();
        if (prnt_plan_snap.empty) {
          console.log(
            `Parent entity ${rollup_entity_id} does not have matching plan ${child_entity_plan.name}`
          );
          continue;
        }

        // TODO: Save plan reference for parent?

        // push the initial version doc into an array of child_versions
        const child_versions: childVersion[] = [
          {
            id: version_snap.id,
            data: child_entity_version,
            ref: version_snap.ref,
            entity_no: child_entity.number,
          },
        ];
        for (const chld_entity_id of rollup_entity.children) {
          // do not requery plan of the child that triggered this function
          if (chld_entity_id === context_params.entity_id) continue;

          // find the plan for this entity. If any child entity does not have the same plan and version, then we do not create the rollup version either
          let chld_coll_path = `entities/${chld_entity_id}/plans`;
          const chld_plan_snap = await db
            .collection(chld_coll_path)
            .where("name", "==", child_entity_plan.name)
            .get();
          if (chld_plan_snap.empty) {
            console.log(
              `Child entity ${chld_entity_id} does not have a plan named ${child_entity_plan.name} >> No rollup will be created`
            );
            return;
          }
          chld_coll_path = `${chld_coll_path}/${chld_plan_snap.docs[0].id}/versions`;
          const chld_version_snap = await db
            .collection(chld_coll_path)
            .where("name", "==", child_entity_version.name)
            .get();
          if (chld_version_snap.empty) {
            console.log(
              `Child entity ${chld_entity_id} does not have a version named ${child_entity_version.name} in plan ${child_entity_plan.name} >> No rollup will be created`
            );
            return;
          }

          // the child does have matching plan and child versions. Also query the entity doc for the number ...
          const chld_entity_snap = await db
            .doc(`entities/${chld_entity_id}`)
            .get();
          if (!chld_entity_snap.exists)
            throw new Error(
              `Child entity doc for ${chld_entity_id} not found. This should not be happening and is a fatal error!`
            );
          const chld_entity = chld_entity_snap.data() as entity_model.entityDoc;

          // add version to list of child versions
          child_versions.push({
            id: chld_version_snap.docs[0].id,
            data: chld_version_snap.docs[0].data() as plan_model.versionDoc,
            ref: chld_version_snap.docs[0].ref,
            entity_no: chld_entity.number,
          });
        }

        console.log(
          `All children of entity ${rollup_entity_id} have a version named ${child_entity_version.name} in plan ${child_entity_plan.name} >> Proceed with updating rollup version`
        );
        console.log(
          `Here are the version data we are using: ${JSON.stringify(
            child_versions
          )}`
        );

        // Loop through the chart of account for the parent and look for matching accounts in each child to combine (add up)
        const prnt_acct_snap = await db.doc(`entities/${rollup_entity_id}/entity_structure/acct`).get();
        if(!prnt_acct_snap.exists) throw new Error(`Unable to find acct document for entity ${rollup_entity_id} >> Fatal error, function terminating.`);  
        const prnt_acct_dict = prnt_acct_snap.data() as entity_model.acctDict;
        
        // Loop through all accounts in the rollup entity chart; then loop through all depts within each account
        for(const acct_id of Object.keys(prnt_acct_dict)) {
          for(const dept_id of prnt_acct_dict[acct_id].depts) {
            let parent_account: plan_model.accountDoc | undefined = undefined; 
            for(const chld_ver of child_versions) {
              const chld_account = getChildAccount(acct_id, dept_id, chld_ver, rollup_entity.entity_embeds);
              // if parent_account == undefined then assign, otherwise add++ (what about dept name??)
            }
          }
        }
      }
    } catch (error) {
      console.log(
        `Error occured while rebuilding rollup entity hierarchy from children: ${error}`
      );
      return;
    }
  });

async function getChildAccount(acct_id: string, dept_id: string, ) {
  // fix the dept string using utils.
  // query the dept collection of the child version
  // return the account if found or undefined
}