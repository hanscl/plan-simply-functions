import * as admin from 'firebase-admin';
// import { deleteCollection } from '../utils/utils';

const db = admin.firestore();

export const deleteVersionForEntityByName = async (entityId: string, planName: string, versionName: string) => {
  try {
    const planSnap = await db.collection(`entities/${entityId}/plans`).where('name', '==', planName).get();

    for (const planDoc of planSnap.docs) {
      const versionSnap = await planDoc.ref.collection('versions').where('name', '==', versionName).get();

      for (const versionDoc of versionSnap.docs) {
        console.log(`Found versionId ${versionDoc.id} of planId ${planDoc.id}. Beginning irreversible deletion ...`);

        await deleteDocWithCollections(`entities/${entityId}/drivers`, versionDoc.id);
        await deleteDocWithCollections(`entities/${entityId}/labor`, versionDoc.id);
        const doc = await findDocIdForVersion(`entities/${entityId}/views`, versionDoc.id, 'version_id');
        if (doc) {
          await deleteDocWithCollections(doc.ref.parent.path, doc.id);
        }
        await deleteDocWithCollections(versionDoc.ref.parent.path, versionDoc.id);
      }
    }
  } catch (error) {
    console.log(`Error occured in [deleteVersionForEntityByName]: ${error}`);
  }
};

const deleteDocWithCollections = async (parentCollectionPath: string, docId: string) => {
  try {
    console.log(
      `[deleteDocWithCollections] Deleting document ${docId} from collection ${parentCollectionPath} with child collections`
    );

    const docRef = db.doc(`${parentCollectionPath}/${docId}`);

    await recursivelyDeleteCollections(docRef);

    console.log(
      `[deleteDocWithCollections] all subcollections/docs have been deleted. delete the single top level doc ...: ${docRef.path}`
    );
    // await docRef.delete();
  } catch (error) {
    console.log(`Error occured in [deleteDocWithCollections]: ${error}`);
  }
};

const recursivelyDeleteCollections = async (docRef: FirebaseFirestore.DocumentReference) => {
  try {
    console.log(`recursively deleting all collections in docPath: ${docRef.path}`);

    const collections = await docRef.listCollections();

    if (collections && collections.length > 0) {
      console.log(
        `found collections ${JSON.stringify(
          collections.map((doc) => doc.id)
        )}. Calling function recursively for all docs within these collections ...`
      );

      for (const coll of collections) {
        const docSnaps = await coll.get();
        for (const doc of docSnaps.docs) {
          await recursivelyDeleteCollections(doc.ref);
        }
        console.log(`recursion done. we can now delete this collection: ${coll.path}`);
        // await deleteCollection(coll, 300);
      }
    } else {
      console.log(`No child collections for this doc ...`);
    }
  } catch (error) {
    console.log(`Error occured in [recursivelyDeleteCollections]: ${error}`);
  }
};

const findDocIdForVersion = async (parentCollectionPath: string, versionId: string, fieldName: string) => {
  try {
    const docSnap = await db.collection(parentCollectionPath).where(fieldName, '==', versionId).get();

    if (docSnap.empty) {
      console.log(
        `[findDocIdForVersion] no doc found for collection ${parentCollectionPath} with fieldName ${fieldName} equaling ${versionId}`
      );
      return null;
    } else {
      console.log(`[findDocIdForVersion] found document: ${docSnap.docs[0]}`);
      return docSnap.docs[0];
    }
  } catch (error) {
    console.log(`Error occured in [findDocIdForVersion]: ${error}`);
    return null;
  }
};
