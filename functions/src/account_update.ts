import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();

const db = admin.firestore();

export const updateAccountRollups = functions.firestore
  .document("entities/{entityId}/plans/{planId}/dept/{acctId}")
  .onUpdate(async (snapshot, context) => {
    try {
      const before = snapshot.before.data();
      const after = snapshot.after.data();

      const entityId = context.params.entityId;
      const planId = context.params.planId;
      const acctId = context.params.acctId;

      console.log("updateAcctRollup triggered for document: ", acctId)

      const diffByMonth: number[] = [];
      let diffTotal = 0;
      let months_changed = false;

      // calculate difference for each month
      for (let i = 0; i < 12; i++) {
        diffByMonth[i] = after["values"][i] - before["values"][i];
        if (diffByMonth[i] !== 0) {
          months_changed = true;
          diffTotal += diffByMonth[i];
        }
      }

      // if there is no change across all 12 months
      if (!months_changed) {
        return null;
      }

      // update the n-level document
      await db
        .doc(`entities/${entityId}/plans/${planId}/dept/${acctId}`)
        .update({
          total: before["total"] + diffTotal,
        });
    

      // get parent rollup from n-level doc
//      let top_Level = false;
      const parent_rollup = after["parent_rollup"];

        // read and update dept_doc
        const rollup_acctId = acctId.replace(
          after["acct"],
          parent_rollup["acct"]
        );
        console.log(acctId, after["acct"], parent_rollup["acct"]);
    //    top_Level = true;
        console.log("attempting to retrieve acct with id: ", rollup_acctId)
        const snapshotDoc = await db
          .doc(`entities/${entityId}/plans/${planId}/dept/${rollup_acctId}`)
          .get();
        const dept_rollup = snapshotDoc.data();
        console.log("dept_rollup object:", dept_rollup)
        if (dept_rollup !== undefined) {
          console.log(dept_rollup["acct"]);

          const newMonthValue: number[] = [];
          let newTotal = 0;
          // calculate each month
          for (let i = 0; i < 12; i++) {
            newMonthValue[i] =
              dept_rollup["values"][i] +
              diffByMonth[i] * parent_rollup["operation"];
          }
          newTotal =
            dept_rollup["total"] + diffTotal * parent_rollup["operation"];

          // set top level to true to end the loop
        //  top_Level = true;

          await db
            .doc(`entities/${entityId}/plans/${planId}/dept/${rollup_acctId}`)
            .update({
              total: newTotal,
              values: newMonthValue,
            });
        }
        else {
            console.log("dept rollup undefined");
        }
      return null;
    } catch (error) {
      console.log("error catch");
      return null;
    }
  });
