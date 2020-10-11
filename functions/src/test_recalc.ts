import * as functions from "firebase-functions";
import * as version_recalc_master from "./version_rollup_recalc_master";

interface testDoc {
  acct_id: string;
  plan_id: string;
  version_id: string;
  values: number[];
}

export const testRecalc = functions.firestore.document("entities/{entityId}/test/test").onUpdate(async (snapshot, context) => {
  try {
    const test_doc = snapshot.after.data() as testDoc;

    console.log(`calling beginVersionRecalc with ${JSON.stringify(test_doc.values)}`);
    await version_recalc_master.beginVersionRollupRecalc(
      {
        acct_id: test_doc.acct_id,
        plan_id: test_doc.plan_id,
        entity_id: context.params.entityId,
        values: test_doc.values,
        version_id: test_doc.version_id,
      },
      false
    );
  } catch (error) {
    console.log("error in testRecalc" + error);
  }
});
