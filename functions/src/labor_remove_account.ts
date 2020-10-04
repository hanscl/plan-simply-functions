import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as plan_model from "./plan_model";

const db = admin.firestore();

export const laborRemoveAccount = functions.firestore
  .document(
    "entities/{entityId}/plans/{planId}/versions/{versionId}/dept/{acctId}"
  )
  .onUpdate(async (snapshot, context) => {
    try {
      const acct_before = snapshot.before.data() as plan_model.accountDoc;
      const acct_after = snapshot.after.data() as plan_model.accountDoc;

      if (
        !(
          acct_before.is_labor_calc === true &&
          acct_after.is_labor_calc === false
        )
      ) {
        console.log(
          `This functions only runs when labor_calc changes from true to false. EXITING now.`
        );
        return;
      }

      // remove accounts from all labor positions that match the dept and acct of this account document
      const position_snap = await db
        .collection(
          `entities/${context.params.entityId}/labor/${context.params.versionId}/positions`
        )
        .where("dept", "==", acct_after.dept)
        .where("acct", "==", acct_after.acct)
        .get();

      for (const pos_doc of position_snap.docs) {
        console.log(`updating ${pos_doc.id}`);
        await pos_doc.ref.update({ acct: admin.firestore.FieldValue.delete() });
      }
    } catch (error) {
      console.log(
        `Error occured while removing GL account from labor model: ${error}`
      );
    }
  });
