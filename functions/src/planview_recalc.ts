import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as model from "./model";

const db = admin.firestore();

export const updatePlanViews = functions.firestore
  .document("entities/{entityId}/plans/{planId}/{divdept}/{acctId}")
  .onUpdate(async (snapshot, context) => {
    try {
      // get document snapshots and convert to accountDoc objects
      const acct_before = snapshot.before.data() as model.accountDoc;
      const acct_after = snapshot.after.data() as model.accountDoc;

      // save context parameters for later use
      const entityId = context.params.entityId;
      const planId = context.params.planId;
      const acctId = context.params.acctId;

      // [1] Ignore the initial trigger when a period value was changed (handled by updateAccountRollups)
      if (acct_after.total === acct_before.total) {
        return;
      }
      // [2] For the account itself, only update the (total, values) for the relevant line (accounts cannot be part of sections)
      if (acct_after.class === "acct") {
        const view_snapshot = await db
          .collection(`entities/${entityId}/plan_views`)
          .where("plan_id", "==", planId)
          .get();

        view_snapshot.forEach(async (plan_view_doc) => {
          const acct_line_snapshot = await plan_view_doc.ref
            .collection("lines")
            .where("full_account", "==", acct_after.full_account)
            .get();

          acct_line_snapshot.forEach(async (acct_line_doc) => {
            await acct_line_doc.ref.update({
              total: acct_after.total,
              values: acct_after.values,
            });
          });
        });

        return; // Nothing else to do for the account level
      }

      // [3] It is a rollup account, either div or dept; process both line items and section updates
      // in any plan view that references this account
      const view_snapshot_rollup = await db
        .collection(`entities/${entityId}/plan_views`)
        .where("plan_id", "==", planId)
        .get();

      view_snapshot_rollup.forEach(async (plan_view_doc) => {    
        const update_promises: Promise<FirebaseFirestore.WriteResult>[] = [];
        // (A) PROCESS LINE DOCS
        const rollup_line_snapshot = await plan_view_doc.ref
          .collection("lines")
          .where("full_account", "==", acct_after.full_account)
          .get();

        // (A-1) UPDATE totals/values for each LINE
        rollup_line_snapshot.forEach(async (rollup_line_doc) => {
          update_promises.push(
            rollup_line_doc.ref.update({
              total: acct_after.total,
              values: acct_after.values,
            })
          );
        });

        // (B) PROCESS SECTION DOCS
        const section_snapshot = await plan_view_doc.ref
          .collection("sections")
          .where("accts.acct_ids", "array-contains", acctId)
          .get();

        section_snapshot.forEach(async (section_doc) => {
          const section_data = section_doc.data() as model.sectionDoc;
          const acct_idx = section_data.accts.acct_ids.indexOf(acctId);

          // (B-1) UPDATE totals/values of acct
          section_data.accts.acct_data[acct_idx].total = acct_after.total;
          section_data.accts.acct_data[acct_idx].values = acct_after.values;

          // (B-2) UPDATE total/total and total/values of section
          section_data.total.total +=
            (acct_after.total - acct_before.total) *
            section_data.accts.acct_data[acct_idx].operation;

          for (
            let idxPeriod = 0;
            idxPeriod < acct_after.values.length;
            idxPeriod++
          ) {
            section_data.total.values[idxPeriod] +=
              (acct_after.values[idxPeriod] - acct_before.values[idxPeriod]) *
              section_data.accts.acct_data[acct_idx].operation;
          }

          // (B-3) WRITE CHANGES TO DATABASE
          update_promises.push(section_doc.ref.set(section_data));
        });

        await Promise.all(update_promises);
      });
    } catch (error) {
      console.log("Error occured during recalc of plan_view" + error);
      return;
    }
  });
