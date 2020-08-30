import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

const db = admin.firestore();

interface versionDoc {
  last_update: admin.firestore.Timestamp;
  name: string;
  number: number;
  calculated: boolean;
  pnl_structure_id: string;
}

interface viewDoc {
  filter?: string;
  org_level: string;
  periods: viewPeriod[];
  plan_id: string;
  pnl_structure_id: string;
  title: string;
  total: viewTotal;
  version_id?: string;
}

interface viewTotal {
  long: string;
  short: string;
}

interface viewPeriod {
  long: string;
  number: number;
  short: string;
}

async function deleteCollection(
  collectionRef: FirebaseFirestore.CollectionReference<
    FirebaseFirestore.DocumentData
  >,
  batchSize: number
) {
  const query = collectionRef.orderBy("__name__").limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(query, resolve).catch(reject);
  });
}

async function deleteQueryBatch(
  query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>,
  resolve: any
) {
  const snapshot = await query.get();

  const batchSize = snapshot.size;
  if (batchSize === 0) {
    // When there are no documents left, we are done
    resolve();
    return;
  }

  // Delete documents in a batch
  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();

  // Recurse on the next process tick, to avoid
  // exploding the stack.
  process.nextTick(() => {
    deleteQueryBatch(query, resolve).catch();
  });
}

export const createViewForPlanVersion = functions.firestore
  .document("entities/{entityId}/plans/{planId}/versions/{versionId}")
  .onUpdate(async (snapshot, context) => {
    try {
      const version_before = snapshot.before.data() as versionDoc;
      const version_after = snapshot.after.data() as versionDoc;
      const entityId = context.params.entityId;
      const planId = context.params.planId;
      const versionId = context.params.versionId;

      if (
        version_after.calculated === false ||
        version_before.calculated === version_after.calculated
      ) {
        return;
      }
      // check if a view exists for this version; if so - delete before continuing
      // then create new plan view and write function for that
      const view_snapshots = await db
        .collection(`entities/${entityId}/views`)
        .where("plan_id", "==", planId)
        .where("version_id", "==", versionId)
        .get();

      view_snapshots.forEach(async (view_doc) => {
        await deleteCollection(view_doc.ref.collection("lines"), 50);
        await deleteCollection(view_doc.ref.collection("sections"), 50);
        await view_doc.ref.delete();
      });

      // find the correct view_template
      const view_templates = await db
        .collection(`entities/${entityId}/view_templates`)
        .where("plan_id", "==", planId)
        .where("pnl_structure_id", "==", version_after.pnl_structure_id)
        .limit(1)
        .get();

      view_templates.forEach(async (template_doc) => {
        const view_doc = template_doc.data() as viewDoc;

        const new_view_ref = await db
          .collection(`entities/${entityId}/views`)
          .add(view_doc);

        for (const collId of ["lines", "sections"]) {
          const doc_snaps = await template_doc.ref.collection(collId).get();
          let write_batch = db.batch();
          const lines_targetcoll = new_view_ref.collection(collId);
          let idx = 0;
          for (const line_doc of doc_snaps.docs) {
            write_batch.set(lines_targetcoll.doc(), line_doc.data());
            idx++;
            if (idx > 400) {
              idx = 0;
              await write_batch.commit();
              write_batch = db.batch();
            }
          }

          if (idx > 0) {
            await write_batch.commit();
          }
        }

        // save the version ID, so we know we're done and can calculate the view
        await new_view_ref.update({
          version_id: versionId,
        });
      });

      return;
    } catch (error) {
      console.log("Error occured during creation of new plan view: " + error);
      return;
    }
  });
