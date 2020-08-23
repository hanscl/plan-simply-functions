import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as model from "./model";

admin.initializeApp();

const db = admin.firestore();

interface parentAccounts {
  div?: model.accountDoc;
  dept?: model.accountDoc;
}

export const updateAccountRollups = functions.firestore
  .document("entities/{entityId}/plans/{planId}/dept/{acctId}")
  .onUpdate(async (snapshot, context) => {
    try {
      // get document snapshots and convert to accountDoc objects
      const acct_before = snapshot.before.data() as model.accountDoc;
      const acct_after = snapshot.after.data() as model.accountDoc;

      // save context parameters for later use
      const entityId = context.params.entityId;
      const planId = context.params.planId;
      const acctId = context.params.acctId;

      // EXIT IF THIS IS AN INITIAL PLAN CALCULATION
      if (
        acct_after.parent_rollup !== undefined &&
        acct_before.parent_rollup === undefined
      ) {
        return;
      }

      // initialize variables for tracking changes in monthly data
      const diffByMonth: number[] = [];
      const months_changed: number[] = [];
      let diffTotal = 0;

      // calculate difference for each month and track which months changed
      // currently changes are triggered for each single change, but this is designed to handle multiple changes in the future
      for (
        let periodIdx = 0;
        periodIdx < acct_before.values.length;
        periodIdx++
      ) {
        diffByMonth[periodIdx] =
          acct_after.values[periodIdx] - acct_before.values[periodIdx];
        if (diffByMonth[periodIdx] !== 0) {
          months_changed.push(periodIdx);
          diffTotal += diffByMonth[periodIdx];
        }
      }

      // if there is no change across all 12 months, exit => this is important to avoid endless update triggers!!
      if (months_changed.length === 0) {
        return;
      }

      // update the account totals
      await db
        .doc(`entities/${entityId}/plans/${planId}/dept/${acctId}`)
        .update({
          total: acct_before.total + diffTotal,
        });

      // Attempt to get parent rollup and check if it exists
      const parent_rollup = acct_after.parent_rollup;

      // IF THERE IS NO PARENT ROLLUP, WE HAVE REACHED THE TOP LEVEL => END FUNCTION
      if (parent_rollup === undefined) return;

      const divdept_parent_accounts: parentAccounts = {
        div: undefined,
        dept: undefined,
      };

      // generate the parent account id by replacing the 'acct' substring
      const dept_rollup_acctId = acctId.replace(
        acct_after.acct,
        parent_rollup.acct
      );

      // also grab the same rollup account for the division
      let div_rollup_acctId = "";
      if (acct_before.dept !== undefined) {
        div_rollup_acctId = dept_rollup_acctId.replace(
          `.${acct_after["dept"]}`,
          ""
        );
      }

      // attempt to fetch document snapshots and store promise in array
      const snapshot_promises: Promise<
        FirebaseFirestore.DocumentSnapshot
      >[] = [];
      snapshot_promises.push(
        db
          .doc(
            `entities/${entityId}/plans/${planId}/dept/${dept_rollup_acctId}`
          )
          .get()
      );
      snapshot_promises.push(
        db
          .doc(`entities/${entityId}/plans/${planId}/div/${div_rollup_acctId}`)
          .get()
      );

      // Wait for all snapshots to be returned, then process each
      const doc_snaphots = await Promise.all(snapshot_promises);

      doc_snaphots.forEach((snap) => {
        if (snap.ref.parent.id in divdept_parent_accounts) {
          divdept_parent_accounts[
            snap.ref.parent.id as keyof typeof divdept_parent_accounts
          ] = snap.data() as model.accountDoc;
        }
      });

      // Update the period value(s) that changed and save the parent doc. This will trigger this function again
      // for the respective DEPT rollup account and then calculate the totals and process thew next parent
      for (const idxPeriod of months_changed) {
        if (divdept_parent_accounts.dept !== undefined) {
          divdept_parent_accounts.dept.values[idxPeriod] +=
            diffByMonth[idxPeriod] * parent_rollup.operation;
        }
        // for the DIV rollup -- also update totals -- there is no separate trigger to process div changes
        if (divdept_parent_accounts.div !== undefined) {
          divdept_parent_accounts.div.values[idxPeriod] +=
            diffByMonth[idxPeriod] * parent_rollup.operation;
          divdept_parent_accounts.div.total +=
            diffByMonth[idxPeriod] * parent_rollup.operation;
        }
      }

      // create array to store all update promises
      const promises_update: Promise<FirebaseFirestore.WriteResult>[] = [];

      if (divdept_parent_accounts.dept !== undefined) {
        promises_update.push(
          db
            .doc(
              `entities/${entityId}/plans/${planId}/dept/${dept_rollup_acctId}`
            )
            .update({
              values: divdept_parent_accounts.dept.values,
            })
        );
      }

      if (divdept_parent_accounts.div !== undefined) {
        promises_update.push(
          db
            .doc(
              `entities/${entityId}/plans/${planId}/div/${div_rollup_acctId}`
            )
            .update({
              total: divdept_parent_accounts.div.total,
              values: divdept_parent_accounts.div.values,
            })
        );
      }

      // make sure all update operations are done before returning
      await Promise.all(promises_update);

      return;
    } catch (error) {
      console.log("Error occured trying to update document" + error);
      return;
    }
  });
