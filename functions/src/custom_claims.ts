import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as entity_model from "./entity_model";

admin.initializeApp();

const db = admin.firestore();

interface userDoc {
  email: string;
  first_name: string;
  last_name: string;
  entities_read: string[];
  entities_write: string[];
  role_names: string[];
  roles: string[];
  active: boolean;
  deleted?: boolean;
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
      const entity_obj = entity_doc.data() as entity_model.entityDoc;

      if (entity_obj.children === undefined) return;

      for (const child_entity of entity_obj.children) {
        if (entities_after.indexOf(child_entity) === -1) {
          entities_after.push(child_entity);
          entities_changed = true;
          console.log("Adding child entity", child_entity);
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

      //console.log(`user_before object: ${JSON.stringify(user_before)}`);
      //console.log(`user_after object: ${JSON.stringify(user_after)}`);

      if (!snapshot.before.exists) {
        console.log('creating user',  user_after.email)
        // create user
        await admin.auth()
            .createUser({
              uid: userId,
              disabled: !user_after.active,
              email: user_after.email
            });

      } else if (!snapshot.after.exists) {
        console.warn('hard delete of user object not supported', user_before?.email);
      } else {
        if (user_before.email !== user_after.email ||
            user_before.active !== user_after.active ||
            user_before.deleted !== user_after.deleted
        ) {
          console.log('updating user',  user_after.email)
          await admin.auth()
              .updateUser(userId, {
                email: user_after.email,
                disabled: user_after.deleted || !user_after.active,
              })
        }
      }

      let read_entities_changed = false;
      let write_entities_changed = false;
      /*** read entities first */
      if (user_before !== undefined) {
        read_entities_changed = await compareEntities(
          user_before.entities_read,
          user_after.entities_read
        );

        write_entities_changed = await compareEntities(
          user_before.entities_write,
          user_after.entities_write
        );
      }

      if (read_entities_changed || write_entities_changed) {
        /*** at least entfity array was updated; write to database */
        console.log(
          "entities array updated; defer updating custom claims. Function will be retriggered."
        );
        // console.log(JSON.stringify(user_after.entities_read));
        // console.log(JSON.stringify(user_after.entities_write));

        await db.doc(`users/${userId}`).update({
          entities_read: user_after.entities_read,
          entities_write: user_after.entities_write,
        });
      } else {
       // console.log("Creating custom claims.");
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
