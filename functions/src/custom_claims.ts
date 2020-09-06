import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();

const db = admin.firestore();

interface entityDoc {
  children?: string[];
  name: string;
  number?: string;
  legal?: string;
  full_account?: string;
  full_account_export?: string;
  acct_type_flip_sign?: string[];
}

interface userDoc {
  email: string;
  first_name: string;
  last_name: string;
  entities_read: string[];
  entities_write: string[];
  role_names: string[];
  roles: string[];
  active: boolean;
}

interface custClaims {
  assigned_roles: string[];
  entities_read: string[];
  entities_write: string[];
}

async function compareEntities(
  entities_before: string[],
  entities_after: string[]
): Promise<boolean> {
  if (JSON.stringify(entities_before) === JSON.stringify(entities_after))
    return false;

  const item_remainder = entities_after.length % 10;
  let loops = (entities_after.length - item_remainder) / 10 + 1;
  if (item_remainder === 0) loops--;

  let entities_changed = false;

  for (let entity_set = 0; entity_set < loops; entity_set++) {
    const query_set = entities_after.slice(
      entity_set * 10,
      entity_set * 10 + 10
    );
    const entity_snapshots = await db
      .collection("entities")
      .where(admin.firestore.FieldPath.documentId(), "in", query_set)
      .where("type", "==", "rollup")
      .get();

    entity_snapshots.forEach(async (entity_doc) => {
      const entity_obj = entity_doc.data() as entityDoc;

      if (entity_obj.children === undefined) return;

      for (const child_entity of entity_obj.children) {
        if (entities_after.indexOf(child_entity) === -1) {
          entities_after.push(child_entity);
          entities_changed = true;
          console.log("Adding child entity" + child_entity);
        }
      }
    });
  }

  return entities_changed;
}

export const writeUserAccount = functions.firestore
  .document("users/{userId}")
  .onWrite(async (snapshot, context) => {
    try {
      const user_before = snapshot.before.data() as userDoc;
      const user_after = snapshot.after.data() as userDoc;
      const userId = context.params.userId;

      /*** read entities first */
      const read_entities_changed = await compareEntities(
        user_before.entities_read,
        user_after.entities_read
      );

      const write_entities_changed = await compareEntities(
        user_before.entities_write,
        user_after.entities_write
      );

      if (read_entities_changed || write_entities_changed) {
        /*** at least entfity array was updated; write to database */
        console.log(
          "entities array updated; defer updating custom claims. Function will be retriggered."
        );
        console.log(JSON.stringify(user_after.entities_read));
        console.log(JSON.stringify(user_after.entities_write));

        await db.doc(`users/${userId}`).update({
          entities_read: user_after.entities_read,
          entities_write: user_after.entities_write,
        });
      } else {
        console.log("Creating custom claims.");
        const user_cc_obj: custClaims = {
          assigned_roles: user_after.roles,
          entities_read: user_after.entities_read,
          entities_write: user_after.entities_write,
        };
        await admin.auth().setCustomUserClaims(userId, user_cc_obj);
      }
    } catch (error) {
      console.log("Error occured while creating custom claims." + error);
      return;
    }
  });
