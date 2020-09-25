import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as plan_model from "./plan_model";
import * as entity_model from "./entity_model";

const db = admin.firestore();

export const planVersionGroupCreate = functions.firestore
  .document("entities/{entityId}/plans/{planId}/versions/{versionId}")
  .onUpdate(async (snapshot, context) => {
    try {
      const version_before = snapshot.before.data() as plan_model.versionDoc;
      const version_after = snapshot.after.data() as plan_model.versionDoc;
      const entityId = context.params.entityId;
      const planId = context.params.planId;
      const versionId = context.params.versionId;

      console.log(
        "processing update to plan version of entity => if calc from FALSE to TRUE THEN calc groupings"
      );

      // Process only if the version was recalculated
      if (
        version_after.calculated === false ||
        version_before.calculated === version_after.calculated
      ) {
        return;
      }

      // Begin processing groups. set the view_ready flag to false until we're done
      await db
        .doc(`entities/${entityId}/plans/${planId}/versions/${versionId}`)
        .update({ ready_for_view: false });

      // find the group definitions
      const plan_snapshot = await db
        .doc(`entities/${entityId}/plans/${planId}`)
        .get();

      if (!plan_snapshot.exists) {
        console.log("No plan document found in plan doc");
        return;
      }

      // save company number for full_account
      const entity_snap = await db.doc(`entities/${entityId}`).get();
      if (!entity_snap.exists) {
        console.log("could not read entity document");
        return;
      }

      const entity_obj = entity_snap.data() as entity_model.entityDoc;

      // get a list of rollups
      const rollup_snap = await db
        .doc(`entities/${entityId}/entity_structure/rollup`)
        .get();

      if (!rollup_snap.exists) {
        console.log("No rollup document defined in entity structure");
        return;
      }

   // const rollup_definitions = rollup_snap.data() as Record<string, string>;
      
      const rollup_doc = rollup_snap.data() as entity_model.rollupSummaryDoc
      const rollup_list: string[] = [];
      rollup_doc.items.forEach(rollupNameMap => rollup_list.push(rollupNameMap.code));

      //const rollup_docid = (plan_snapshot.data() as plan_model.planDoc).account_rollup;

      const group_snapshot = await db
        .doc(
          `entities/${entityId}/entity_structure/group`
        )
        .get();

      if (!group_snapshot.exists) {
        console.log("No group definitions found");
        return;
      }

      let group_wx_batch = db.batch();
      let group_ctr = 0;

      const group_list = (group_snapshot.data() as entity_model.groupDoc).groups;
      for (const group_obj of group_list) {
        //const group_obj = group_doc.data() as entity_model.groupDoc;
        console.log("processing group doc with code: " + group_obj.code);

        for (const rollup_acct of rollup_list) {
          const acct_snapshot = await db
            .collection(
              `entities/${entityId}/plans/${planId}/versions/${versionId}/${group_obj.level}`
            )
            .where("acct", "==", rollup_acct)
            .where(group_obj.level, "in", group_obj.children)
            .get();

          // skip if no child accounts for this rollup
          if(acct_snapshot.empty) continue;

          let total = 0;
          const values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
          let acct_div = "";
          const grp_children: string[] = [];
          for (const child_doc of acct_snapshot.docs) {
            const child_acct = child_doc.data() as plan_model.accountDoc;
            console.log(
              "adding child " +
                child_acct.full_account +
                " to parent " +
                group_obj.code
            );

            child_acct.values.forEach((child_val, index) => {
              values[index] += child_val;
            });
            total += child_acct.total;

            // save child divdept to array
            grp_children.push(child_acct.full_account);

            // update the child doc so we know it is now part of a group
            group_wx_batch.update(child_doc.ref, { is_group_child: true });

            // save division if we are processing dept level
            if (group_obj.level === "dept" && acct_div === "")
              acct_div = child_acct.div;
          }

          let acct_dept: string | undefined = undefined;
          let full_account = "";
          if (group_obj.level === "div") {
            acct_div = group_obj.code;
            full_account = entity_obj.full_account
              .replace("@acct@", rollup_acct)
              .replace(".@dept@", "")
              .replace("@div@", acct_div);
          } else {
            acct_dept = group_obj.code;
            full_account = entity_obj.full_account
              .replace("@acct@", rollup_acct)
              .replace("@dept@", acct_dept)
              .replace("@div@", acct_div);
          }

          // build the group account obj and add to batch
          const rollup_name_map = rollup_doc.items.find(item => item.code === rollup_acct);
          if(rollup_name_map === undefined) throw new Error(`Unable to find name for rollup ${rollup_name_map}`);
          const group_acct: plan_model.accountDoc = {
            acct: rollup_acct,
            class: "rollup",
            div: acct_div,
            full_account: full_account,
            acct_name: rollup_name_map.name,
            divdept_name: group_obj.name,
            group: true,
            is_group_child: false,
            total: total,
            values: values,
            group_children: grp_children,
          };

          if (acct_dept !== undefined) {
            group_acct.dept = acct_dept;
          }

          console.log("ADDING GROUP: " + JSON.stringify(group_acct));
          const docpath = `entities/${entityId}/plans/${planId}/versions/${versionId}/${group_obj.level}/${full_account}`;
          console.log(docpath);
          group_wx_batch.set(db.doc(docpath), group_acct);
          group_ctr++;
          // intermittent write
          if (group_ctr > 400) {
            await group_wx_batch.commit();
            group_wx_batch = db.batch();
            group_ctr = 0;
          }
        }
      }

      if (group_ctr > 0) {
        console.log("Batch writing " + group_ctr + " documents");
        await group_wx_batch.commit();
      }

      // all done. Set the view_ready flag to true so the view will be generated
      await db
        .doc(`entities/${entityId}/plans/${planId}/versions/${versionId}`)
        .update({ ready_for_view: true });

      return;
    } catch (error) {
      console.log(
        "Error occured during calculation of group rollups: " + error
      );
      return;
    }
  });
