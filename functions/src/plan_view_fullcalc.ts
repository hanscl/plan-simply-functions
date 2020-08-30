import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as viewModel from "./model_view";
import * as acctModel from "./model_acct";

const db = admin.firestore();

export const planViewFullCalc = functions.firestore
  .document("entities/{entityId}/views/{viewId}")
  .onUpdate(async (snapshot, context) => {
    try {
      const view_before = snapshot.before.data() as viewModel.viewDoc;
      const view_after = snapshot.after.data() as viewModel.viewDoc;
      const entityId = context.params.entityId;
      const viewId = context.params.viewId;

      if (
        !(
          view_before.version_id === undefined &&
          view_after.version_id !== undefined
        )
      ) {
        console.log("Version Id not added during update. Exit Cloud Function.");
        return;
      }

      // recalculate lines first
      await updateLines(entityId, viewId, view_after);

      // then recalculate sections
      await updateSections(entityId, viewId, view_after);
    } catch (error) {
      console.log("Error occured during creation of new plan view: " + error);
      return;
    }
  });

async function updateSections(
  entityId: string,
  viewId: string,
  view_after: viewModel.viewDoc
) {
  try {
    const section_snapshots = await db
      .collection(`entities/${entityId}/views/${viewId}/sections`)
      .get();
    let write_batch = db.batch();
    let idx = 0;
    for (const section_doc of section_snapshots.docs) {
      const section_obj = section_doc.data() as viewModel.sectionDoc;

      section_obj.total.total = 0;
      section_obj.total.values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

      for (
        let acct_idx = 0;
        acct_idx < section_obj.accts.acct_ids.length;
        acct_idx++
      ) {
        const acct_snapshot = await db
          .collection(
            `entities/${entityId}/plans/${view_after.plan_id}/versions`
          )
          .doc(
            `${view_after.version_id}/${section_obj.accts.acct_data[acct_idx].level}/${section_obj.accts.acct_ids[acct_idx]}`
          )
          .get();

        if (acct_snapshot.exists) {
          const acct_obj = acct_snapshot.data() as acctModel.accountDoc;
          // save account to section
          section_obj.accts.acct_data[acct_idx].total = acct_obj.total;
          section_obj.accts.acct_data[acct_idx].values = acct_obj.values;

          // add to total
          const operation = section_obj.accts.acct_data[acct_idx].operation;
          section_obj.total.total += acct_obj.total * operation;
          for (let periodIdx = 0; periodIdx < 12; periodIdx++) {
            section_obj.total.values[periodIdx] +=
              acct_obj.values[periodIdx] * operation;
          }
        } else {
            console.log("acct snapshot exists does not exist. writing 0s.");
          section_obj.accts.acct_data[acct_idx].total = 0;
          section_obj.accts.acct_data[acct_idx].values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        }
      }

      // section obj complete => add update to batch
      write_batch.set(section_doc.ref, section_obj);
      idx++;
      // intermittent write if the batch reaches 400
      if (idx > 400) {
        idx = 0;
        await write_batch.commit();
        write_batch = db.batch();
      }
    }
    // final commit of any remaining items in the batch
    if (idx > 0) {
      await write_batch.commit();
    }
  } catch (error) {
    console.log("Error occured while updating view sections: " + error);
  }
}

async function updateLines(
  entityId: string,
  viewId: string,
  view_after: viewModel.viewDoc
) {
  try {
    console.log("begin updating lines");
    const line_snapshots = await db
      .collection(`entities/${entityId}/views/${viewId}/lines`)
      .get();
    let write_batch = db.batch();
    let idx = 0;
    for (const line_doc of line_snapshots.docs) {
      const line_obj = line_doc.data() as viewModel.lineDoc;

      // figure out if this is a dept or div level account, then query the account data
      const collId = line_obj.dept === undefined ? "div" : "dept";
      const acct_snapshot = await db
        .doc(
          `entities/${entityId}/plans/${view_after.plan_id}/versions/${view_after.version_id}/${collId}/${line_obj.full_account}`
        )
        .get();

      // add update to batch
      if (acct_snapshot.exists) {
        const acct_obj = acct_snapshot.data() as acctModel.accountDoc;
        write_batch.update(line_doc.ref, {
          total: acct_obj.total,
          values: acct_obj.values,
        });
      } else {
        console.log("acct snapshot exists does not exist. writing 0s.");
        write_batch.update(line_doc.ref, {
          total: 0,
          values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        });
      }

      idx++;
      // intermittent write if the batch reaches 400
      if (idx > 400) {
        idx = 0;
        await write_batch.commit();
        write_batch = db.batch();
      }
    }
    // final commit of any remaining items in the batch
    if (idx > 0) {
      await write_batch.commit();
    }
  } catch (error) {
    console.log("Error occured while updating view lines: " + error);
  }
}
