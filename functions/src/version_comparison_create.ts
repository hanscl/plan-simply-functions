//import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as compModel from "./version_comparison_model";

const db = admin.firestore();

export async function createVersionComparison(options: compModel.VersionCompWithUser) {
  try {
    // create the document (or update in case this is a retry because the transaction failed)
    let compDocObj: compModel.VersionCompDocument | undefined = undefined;
    const compDocId = `comparisons/${options.baseVersion}_${options.compareVersion}`;
    const compDoc = await db.doc(compDocId).get();

    // if this document already exists, retain user ids
    if (compDoc.exists) {
      compDocObj = compDoc.data() as compModel.VersionCompDocument;
      // add user id from this request if it is not in the array yet
      if (!compDocObj.userIds.includes(options.userId)) compDocObj.userIds.push(options.userId);
    } else {
      compDocObj = {
        versionIds: [options.baseVersion.versionId, options.compareVersion.versionId],
        plansIds: [options.baseVersion.planId, options.compareVersion.planId],
        userIds: [options.userId],
      }; // create a new document structure
    }

    if (!compDocObj) throw new Error(`Unable to retrieve or create version comparison object`);
  
    // set document (create or update)
    await db.doc(compDocId).set(compDocObj);

    // begin transaction - lock the version document until we're done
    const txResult = await db.runTransaction(async (compTx) => {
        if(!compDocObj) return false;

        const versionDocs = [];
        for(let idx = 0; idx < compDocObj.versionIds.length; idx++) {
            versionDocs.push(await compTx.get(db.doc(`entities/${options.entityId}/plans/${compDocObj.plansIds[idx]}/versions/${compDocObj.versionIds[idx]}`)));
        }

      // perform recalc in here to ensure no other update runs concurrently on this version

      // final updates here
      // recalc_tx.update(version_doc.ref, { last_update: admin.firestore.Timestamp.now() });

      return "all good";
    });
    console.log(txResult);
  } catch (error) {}
}


