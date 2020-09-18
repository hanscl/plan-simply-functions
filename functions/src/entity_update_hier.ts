import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as entity_model from "./entity_model";

const db = admin.firestore();

export const entityHierarchyUpdate = functions.firestore
  .document("entities/{entityId}/entity_structure/{driverDocId}")
  .onWrite(async (snapshot, context) => {
    try {
      if (
        context.params.driverDocId === "hier" ||
        context.params.driverDocId === "acct" ||
        context.params.driverDocId === "rollups"
      ) {
        // avoid endless updates
        console.log(
          "Updated hierarchy document itself or an document that is not relevant => exit update function."
        );
        return;
      }

      // this won't happen very often ... no need to see what changed. We will just process the whole hierarchy
      // Begin with getting all divs
      let doc_path = `entities/${context.params.entityId}/entity_structure/div`;
      const div_snapshot = await db.doc(doc_path).get();
      if (!div_snapshot.exists) {
        console.log(`Could not find division document at: ${doc_path}`);
        return;
      }
      const div_dict = div_snapshot.data() as entity_model.divDict;
      const div_list = Object.keys(div_dict);

      // also load all depts at this stage -- it's only one doc anyway
      doc_path = `entities/${context.params.entityId}/entity_structure/dept`;
      const dept_snapshot = await db.doc(doc_path).get();
      if (!dept_snapshot.exists) {
        console.log(`Could not find department document at: ${doc_path}`);
        return;
      }
      const dept_dict = dept_snapshot.data() as entity_model.deptDict;

      // get default group path
      const coll_path = `entities/${context.params.entityId}/account_rollups`;
      const rollup_snap = await db
        .collection(coll_path)
        .where("default", "==", true)
        .get();
      if (rollup_snap.empty) {
        console.log(
          `Could not find default account rollup document at: ${coll_path}`
        );
        return;
      }
      const group_coll_ref = rollup_snap.docs[0].ref.collection("groups");

      const hier_obj: entity_model.hierDoc = { children: [] };

      for (const div_id of div_list) {
        const div_level: entity_model.hierLevel = {
          level: "div",
          id: div_id,
          name: div_dict[div_id].name,
          children: [],
        };
        // first: add dept groups if there are any
        const group_snap = await group_coll_ref
          .where("div", "==", div_id)
          .get();
        const depts_in_groups: string[] = [];
        group_snap.forEach((group_doc) => {
          const group_obj = group_doc.data() as entity_model.groupDoc;
          const group_level: entity_model.hierLevel = {
            id: group_obj.code,
            name: group_obj.name,
            level: "dept",
            children: [],
          };
          group_obj.children.forEach((dept_id) => {
            depts_in_groups.push(dept_id);
            const dept_level: entity_model.hierLevel = {
              id: dept_id,
              name: dept_dict[dept_id].name,
              level: "dept",
            };
            group_level.children?.push(dept_level);
          });
          div_level.children?.push(group_level);
        });

        // process other depts
        div_dict[div_id].depts.forEach((dept_id) => {
          if (depts_in_groups.indexOf(dept_id) > -1) return;
          const dept_level: entity_model.hierLevel = {
            level: "dept",
            id: dept_id,
            name: dept_dict[dept_id].name,
          };
          div_level.children?.push(dept_level);
        });
        hier_obj.children.push(div_level);

        // save to firestore
        doc_path = `entities/${context.params.entityId}/entity_structure/hier`;
        await db.doc(doc_path).set(hier_obj);
      }
    } catch (error) {
      console.log(`Error occured during entity hierarchy update: ${error}`);
      return;
    }
  });
