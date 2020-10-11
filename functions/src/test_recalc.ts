import * as functions from "firebase-functions";
import * as version_recalc_master from "./version_rollup_recalc_master";

interface testDoc {
  acct_id: string;
  plan_id: string;
  version_id: string;
  value: number;
  loops: number;
}

export const testRecalc = functions.firestore.document("entities/{entityId}/test/test").onUpdate(async (snapshot, context) => {
  try {
    const test_doc = snapshot.after.data() as testDoc;
    const values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    for (let idx = 0; idx < test_doc.loops; idx++) {
      for (let mnth = 0; mnth < values.length; mnth++) {
        values[mnth] = test_doc.value * 5 * (idx + 1);
      }
      console.log(`calling beginVersionRecalc with ${JSON.stringify(values)}`);
      await version_recalc_master.beginVersionRollupRecalc(
        { acct_id: test_doc.acct_id, plan_id: test_doc.plan_id, entity_id: context.params.entityId, values: values, version_id: test_doc.version_id },
        false
      );
    }
  } catch (error) {
    console.log("error in testRecalc" + error);
  }
});
