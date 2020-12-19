import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as plan_model from "./plan_model";
import * as entity_model from "./entity_model";
import * as view_model from "./view_model";
import * as utils from "./utils";

enum RollDirection {
  Div_fromDivToDeptOrGroup,
  Dept_fromGroupToDept,
  Dept_fromRollupToRollup,
  Dept_fromRollupToAcct,
  Dept_None,
}

interface contextParams {
  entityId: string;
  planId: string;
  versionId: string;
  n_level_rollups: string[];
}

interface accountForSection {
  operation: number;
  account: plan_model.accountDoc;
}

const db = admin.firestore();

export const planViewGenerate = functions.firestore
  .document("entities/{entityId}/plans/{planId}/versions/{versionId}")
  .onUpdate(async (snapshot, context) => {
    try {
      const version_before = snapshot.before.data() as plan_model.versionDoc;
      const version_after = snapshot.after.data() as plan_model.versionDoc;
      const context_params: contextParams = {
        entityId: context.params.entityId,
        planId: context.params.planId,
        versionId: context.params.versionId,
        n_level_rollups: [],
      };

      // Process only if the version was recalculated
      if (version_after.ready_for_view === false || version_before.ready_for_view === version_after.calculated) {
        console.log(`EXITING FUNCTION`);
        return;
      }

      // Get entity number and full_account format strings
      const entity_snap = await db.doc(`entities/${context_params.entityId}`).get();

      if (!entity_snap.exists) throw new Error("Could not find entity document for id: " + context_params.entityId);

      const entity_obj = entity_snap.data() as entity_model.entityDoc;
      const full_acct_formats: string[] = [];
      const ent_no = entity_obj.number;
      full_acct_formats.push(entity_obj.full_account);
      if (entity_obj.div_account !== undefined) full_acct_formats.push(entity_obj.div_account);

      // check if a view exists for this version; if so - delete before continuing
      // then create new plan view and write function for that
      const view_snapshots = await db
        .collection(`entities/${context_params.entityId}/views`)
        .where("plan_id", "==", context_params.planId)
        .where("version_id", "==", context_params.versionId)
        .get();

      view_snapshots.forEach(async (view_doc) => {
        const sect_snapshots = await view_doc.ref.collection(`by_org_level`).get();
        sect_snapshots.forEach(async (sect_doc) => {
          await utils.deleteCollection(sect_doc.ref.collection("sections"), 300);
        });
        await utils.deleteCollection(view_doc.ref.collection("by_org_level"), 300);
        await view_doc.ref.delete();
      });

      // Get the plan document to transfer total and period defs
      const plan_snapshot = await db.doc(`entities/${context_params.entityId}/plans/${context_params.planId}`).get();

      if (!plan_snapshot.exists)
        throw new Error("Could not find plan for view. Which is strange, because this function gets triggered by a plan version :-/");

      const plan_obj = plan_snapshot.data() as plan_model.planDoc;

      // Create a new view
      const new_view: view_model.viewDoc = {
        periods: plan_obj.periods,
        plan_id: context_params.planId,
        pnl_structure_id: version_after.pnl_structure_id,
        title: `${context_params.entityId} Income Statement`,
        total: plan_obj.total,
        version_id: context_params.versionId,
      };
      // ... & save to firestore
      const new_view_ref = await db.collection(`entities/${context_params.entityId}/views`).add(new_view);

      // find n-level rollups
      const rollup_doc_snap = await db
        .collection(`entities/${context_params.entityId}/entity_structure/rollup/rollups`)
        .where("n_level", "==", true)
        .get();

      if (rollup_doc_snap.empty) throw new Error("Unable to find any n-level rollup accounts, which should not be happening!");

      for (const rollup_def_doc of rollup_doc_snap.docs) {
        const rollup_def_obj = rollup_def_doc.data() as entity_model.EntityRollupDocument;
        context_params.n_level_rollups.push(rollup_def_obj.rollup);
      }

      // load pnl structure doc
      const pnl_struct_snap = await db.doc(`entities/${context_params.entityId}/pnl_structures/${version_after.pnl_structure_id}`).get();
      if (!pnl_struct_snap.exists) throw new Error("Could not find P&L Structure definition with doc id: " + version_after.pnl_structure_id);
      const pnl_struct_obj = pnl_struct_snap.data() as view_model.pnlStructure;

      // get list of divs for the entity
      const div_snap = await db.doc(`entities/${context_params.entityId}/entity_structure/div`).get();
      if (!div_snap.exists) throw new Error("Could not find Divisions in Entity Structure collection");
      const div_definitions = div_snap.data() as entity_model.divDict;
      const div_list: string[] = Object.keys(div_definitions);

      // get list of groups for the entity
      let groups_list: entity_model.groupObj[] = [];
      const group_snap = await db.doc(`entities/${context_params.entityId}/entity_structure/group`).get();
      if (group_snap.exists) {
        groups_list = (group_snap.data() as entity_model.groupDoc).groups;
      }

      let write_batch = db.batch();
      let write_ctr = 0;

      // create the org_level_docs and save the ids
      const cmp_view_doc_ref = await new_view_ref.collection("by_org_level").add({ level: "company", filter: ent_no }); // TODO ADD CMP FILTER
      const view_doc_refs: view_model.sectionDocRefDict = {};
      for (const div_id of div_list) {
        // add depts within div
        for (const dept_id of div_definitions[div_id].depts) {
          view_doc_refs[dept_id] = await new_view_ref.collection("by_org_level").add({ level: "dept", filter: dept_id });
        }
        // add groups within div
        for (const group_obj of groups_list.filter((group_item) => group_item.div === div_id)) {
          view_doc_refs[group_obj.code] = await new_view_ref.collection("by_org_level").add({ level: "dept", filter: group_obj.code });
        }
        // and add the div document itself
        view_doc_refs[div_id] = await new_view_ref.collection("by_org_level").add({ level: "div", filter: div_id });
      }

      // Repeat the code below for each section
      for (let section_pos = 0; section_pos < pnl_struct_obj.sections.length; section_pos++) {
        const section_obj = pnl_struct_obj.sections[section_pos];
        // Get the list of divs for the filters
        const section_div_accts: accountForSection[] = [];
        for (const filterDef of section_obj.filters) {
          const group_acct_snap = await db
            .collection(`entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/div`)
            .where("div", "in", filterDef.div)
            .where("acct", "==", filterDef.rollup)
            .get();

          if (group_acct_snap.empty) continue;

          // save all div accts for this filter
          for (const acct_doc of group_acct_snap.docs) {
            section_div_accts.push({
              operation: filterDef.operation,
              account: acct_doc.data() as plan_model.accountDoc,
            });
          }
        } // END Processing Filters from Section Document


        // Create section document for COMPANY & DIVs
        let cmp_view_sect: view_model.viewSection | undefined = undefined;
        // If we did not find any division accounts to sum up for the filters of this section, do not attempt to create the PnlAggregate
        if (section_div_accts.length > 0) {
          const pnl_doc_id = await createPnlAggregate(context_params, section_div_accts, new_view_ref.id);

          if (section_obj.org_levels.includes("entity")) {
            cmp_view_sect = {
              name: section_obj.name,
              position: section_pos,
              header: section_obj.header,
              totals_level: "pnl",
              totals_id: pnl_doc_id,
            };
          }
        }

        // create empty object to hold dept sections
        const dept_view_sects = {} as view_model.viewSectionDict;
        const div_view_sects = {} as view_model.viewSectionDict;
        for (const div_id of div_list) {
          // filter accounts by div id
          const fltrd_div_accts = section_div_accts.filter((acct_item) => {
            return acct_item.account.div === div_id;
          });

          // skip adding section if current div does not have any accounts in it
          if (fltrd_div_accts.length === 0) continue;

          // create view section and add to map object
          div_view_sects[div_id] = await createDivViewSection(section_obj, section_pos, fltrd_div_accts, context_params, new_view_ref.id);

          // also create dept sections
          for (const dept_id of div_definitions[div_id].depts) {
            const new_dept_sect = await createDeptViewSection(
              section_obj,
              section_pos,
              fltrd_div_accts,
              context_params,
              new_view_ref.id,
              dept_id,
              full_acct_formats
            );
            if (new_dept_sect !== undefined) dept_view_sects[dept_id] = new_dept_sect;
          }
          // and include any groups
          const groups_for_div = groups_list.filter((group_item) => group_item.div === div_id);
          for (const group_obj of groups_for_div) {
            const new_dept_sect = await createDeptViewSection(
              section_obj,
              section_pos,
              fltrd_div_accts,
              context_params,
              new_view_ref.id,
              group_obj.code,
              full_acct_formats
            );
            if (new_dept_sect !== undefined) dept_view_sects[group_obj.code] = new_dept_sect;
          }
        }

        if (section_obj.lines) {
          // we have lines to add; create array in this view section
          if (cmp_view_sect !== undefined) cmp_view_sect.lines = [];

          for (const div_line_acct of section_div_accts) {
            const curr_line: view_model.viewChild = {
              level: div_line_acct.account.dept !== undefined ? "dept" : "div",
              acct: div_line_acct.account.full_account,
              desc: div_line_acct.account.divdept_name,
            };
            // save to lines in parent
            if (cmp_view_sect !== undefined && cmp_view_sect.lines !== undefined) cmp_view_sect.lines.push(curr_line);
            // ... and call the recursive function
            section_pos;
            await rollDownLevelOrAcct(
              div_line_acct.account,
              curr_line,
              undefined, //parent_dept_obj => does not exist on this level
              context_params,
              div_view_sects,
              dept_view_sects
            );
          }
        } // END processing lines for section object

        // Add to BATCH & intermittent write

        if (cmp_view_sect !== undefined) {
          write_batch.set(cmp_view_doc_ref.collection("sections").doc(), cmp_view_sect);
        }
        write_ctr++;
        for (const div_id of Object.keys(div_view_sects)) {
          if (section_obj.org_levels.includes("dept")) {
            // write sections to view document :: DEPT
            for (const dept_id of div_definitions[div_id].depts) {
              if (dept_view_sects[dept_id] !== undefined) {
                write_batch.set(view_doc_refs[dept_id].collection("sections").doc(), dept_view_sects[dept_id]);
              }
            }
            // write sections to view document :: GROUP
            for (const group_obj of groups_list.filter((group_item) => group_item.div === div_id)) {
              if (dept_view_sects[group_obj.code] !== undefined) {
                write_batch.set(view_doc_refs[group_obj.code].collection("sections").doc(), dept_view_sects[group_obj.code]);
              }
            }
          }
          // write sections to view document :: DIV
          if (section_obj.org_levels.includes("div")) {
            write_batch.set(view_doc_refs[div_id].collection("sections").doc(), div_view_sects[div_id]);
            write_ctr++;
          }
        }

        if (write_ctr > 400) {
          await write_batch.commit();
          write_batch = db.batch();
          write_ctr = 0;
        }
      } // END Processing Sections from PnL Structure

      if (write_ctr > 0) {
        await write_batch.commit();
      }

      return;
    } catch (error) {
      console.log("Error occured during view generation " + error);
      return;
    }
  });

/** Create Section for a Division */
async function createDivViewSection(
  section_obj: view_model.pnlSection,
  section_pos: number,
  fltrd_div_accts: accountForSection[],
  context_params: contextParams,
  view_id: string
): Promise<view_model.viewSection> {
  // setup basic object
  const div_view_sect: view_model.viewSection = {
    name: section_obj.name,
    header: section_obj.header,
    position: section_pos,
  };

  // if we have more than one account for this division => create a custom PNL aggregate
  // otherwise, just reference this div account
  if (fltrd_div_accts.length > 1) {
    div_view_sect.totals_level = "pnl";
    div_view_sect.totals_id = await createPnlAggregate(context_params, fltrd_div_accts, view_id);
  } else {
    div_view_sect.totals_level = "div";
    div_view_sect.totals_id = fltrd_div_accts[0].account.full_account;
  }

  return div_view_sect;
}

/** Create section for a department */
async function createDeptViewSection(
  section_obj: view_model.pnlSection,
  section_pos: number,
  fltrd_div_accts: accountForSection[],
  context_params: contextParams,
  view_id: string,
  dept_id: string,
  full_acct_formats: string[]
): Promise<view_model.viewSection | undefined> {
  // setup basic object
  const dept_view_sect: view_model.viewSection = {
    name: section_obj.name,
    header: section_obj.header,
    position: section_pos,
  };
  // create dept accounts collection from div
  //  for(const acct_for_sect of fltrd_div_accts)
  const fltrd_dept_accts: accountForSection[] = [];
  for (const acct_obj of fltrd_div_accts) {
    const compnts = utils.extractComponentsFromFullAccountString(acct_obj.account.full_account, full_acct_formats);
    const full_account_dept = utils.buildFullAccountString(full_acct_formats, {
      ...compnts,
      dept: dept_id,
    });

    const doc_path = `entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/dept/${full_account_dept}`;
    const acct_snap = await db.doc(doc_path).get();
    if (acct_snap.exists) {
      fltrd_dept_accts.push({
        operation: acct_obj.operation,
        account: acct_snap.data() as plan_model.accountDoc,
      });
    }
  }

  // if we have more than one account for this dept => create a custom PNL aggregate
  // otherwise, just reference this dept account
  if (fltrd_dept_accts.length === 1) {
    dept_view_sect.totals_level = "dept";
    dept_view_sect.totals_id = fltrd_dept_accts[0].account.full_account;

    return dept_view_sect;
  } else if (fltrd_dept_accts.length > 1) {
    dept_view_sect.totals_level = "pnl";
    dept_view_sect.totals_id = await createPnlAggregate(context_params, fltrd_dept_accts, view_id);
    return dept_view_sect;
  }

  return undefined;
}

async function rollDownLevelOrAcct(
  parent_acct: plan_model.accountDoc,
  parent_view_obj: view_model.viewChild,
  parent_dept_obj: view_model.viewSection | undefined,
  context_params: contextParams,
  div_sections: view_model.viewSectionDict,
  dept_sections: view_model.viewSectionDict
) {
  const rollDir: RollDirection = determineRollDirection(parent_acct, context_params.n_level_rollups);
  if (rollDir === RollDirection.Dept_None) return;

  // query the child accounts based on the rolldirection
  let child_acct_snap = undefined;
  const version_dept_ref = db.collection(`entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/dept`);
  if (rollDir === RollDirection.Div_fromDivToDeptOrGroup) {
    child_acct_snap = await version_dept_ref
      .where("div", "==", parent_acct.div)
      .where("acct", "==", parent_acct.acct)
      .where("is_group_child", "==", false)
      .get();
  } else if (rollDir === RollDirection.Dept_fromGroupToDept) {
    child_acct_snap = await version_dept_ref.where("full_account", "in", parent_acct.group_children).get();
  }
  // TODO can this be handled indeed with one case? If so, remove n_level flag from rollups and remove query in this function, then consolidate flags
  else if (rollDir === RollDirection.Dept_fromRollupToRollup || rollDir === RollDirection.Dept_fromRollupToAcct) {
    child_acct_snap = await version_dept_ref.where("parent_rollup.acct", "==", parent_acct.acct).where("dept", "==", parent_acct.dept).get();
  }

  if (child_acct_snap === undefined || child_acct_snap.empty) {
    return;
  }

  // we know the current account has children; create the array in the parent view object
  parent_view_obj.child_accts = [];

  for (const child_acct_doc of child_acct_snap.docs) {
    const child_acct = child_acct_doc.data() as plan_model.accountDoc;
    // select descriptor for this child account
    const acct_desc = getLineDescription(child_acct, rollDir);
    // create new view
    const curr_child: view_model.viewChild = {
      level: child_acct.dept !== undefined ? "dept" : "div",
      acct: child_acct.full_account,
      desc: acct_desc,
    };

    // save this account to the array of child accts in the parent object
    parent_view_obj.child_accts.push(curr_child);

    // if a parent_dept_obj was passed, then we need to add the current child to this new section object as well
    if (parent_dept_obj !== undefined) {
      if (parent_dept_obj.lines === undefined) {
        parent_dept_obj.lines = [];
      }
      parent_dept_obj.lines?.push(curr_child);
    }

    // if we rolled down from DIV then (i) the child needs to be added to the DIV view section as well and
    // (ii) we need to find the DEPT section and pass it to the recursive function call to ensure that
    // the next level down is added to both the div_child and the dept_section

    if (rollDir === RollDirection.Div_fromDivToDeptOrGroup || rollDir === RollDirection.Dept_fromGroupToDept) {
      // only if coming FROM div add to DIV as well
      if (rollDir === RollDirection.Div_fromDivToDeptOrGroup) {
        // (i) Add DIV line to the VIEW SECTION object
        if (div_sections[child_acct.div].lines === undefined) {
          div_sections[child_acct.div].lines = [];
        }
        div_sections[child_acct.div].lines?.push(curr_child);
      }
      // IN BOTH CASES: (ii) Pass DEPT section to recursive call to attach the lower levels to the DEPT view section object
      await rollDownLevelOrAcct(
        child_acct,
        curr_child,
        child_acct.dept === undefined ? undefined : dept_sections[child_acct.dept],
        context_params,
        div_sections,
        dept_sections
      );
    } else {
      // Otherwise, just pass undefined instead of the dept section and recursively call this function with the current child
      await rollDownLevelOrAcct(child_acct, curr_child, undefined, context_params, div_sections, dept_sections);
    }
  }
}

function getLineDescription(acct: plan_model.accountDoc, rollDir: RollDirection): string {
  if (acct.class === "acct") {
    return `${acct.acct} - ${acct.acct_name}`;
  }

  if (rollDir === RollDirection.Div_fromDivToDeptOrGroup || rollDir === RollDirection.Dept_fromGroupToDept) {
    return acct.divdept_name;
  }

  if (rollDir === RollDirection.Dept_fromRollupToRollup || rollDir === RollDirection.Dept_fromRollupToAcct) {
    return acct.acct_name;
  }

  return "N/A";
}

function determineRollDirection(acct: plan_model.accountDoc, n_level_rollups: string[]): RollDirection {
  if (acct.dept === undefined) {
    // process div level logic
    return RollDirection.Div_fromDivToDeptOrGroup;
  }

  // process dept level logic
  if (acct.group === true) {
    return RollDirection.Dept_fromGroupToDept;
  }

  if (acct.class === "acct") {
    return RollDirection.Dept_None;
  }

  // if we get here, it means that we need to roll down from Rollup to the child-rollup or the acct
  if (acct.acct in n_level_rollups) {
    return RollDirection.Dept_fromRollupToAcct;
  } else {
    return RollDirection.Dept_fromRollupToRollup;
  }
}

async function createPnlAggregate(context_params: contextParams, sub_accts: accountForSection[], view_id: string): Promise<string> {
  const pnl_aggregate: view_model.pnlAggregateDoc = {
    child_accts: [],
    child_ops: [],
    total: 0,
    values: getEmptyValuesArray(),
    view_id: view_id,
  };
  let pnl_doc_ref = "";
  for (const section_acct_obj of sub_accts) {
    pnl_aggregate.child_accts.push(section_acct_obj.account.full_account);
    pnl_aggregate.child_ops.push(section_acct_obj.operation);
    pnl_aggregate.total += section_acct_obj.account.total * section_acct_obj.operation;
    pnl_aggregate.values = addValueArrays(pnl_aggregate.values, section_acct_obj.account.values, section_acct_obj.operation);
    // add to pnl_doc_ref
    pnl_doc_ref = pnl_doc_ref.concat(`[${section_acct_obj.account.full_account}#${convertOperationToText(section_acct_obj.operation)}]`);
  }

  await db
    .doc(`entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/pnl/${pnl_doc_ref}`)
    .set(pnl_aggregate);
  // const new_doc_ref = await db
  //   .collection(
  //     `entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/pnl`
  //   )
  //   .add(pnl_aggregate);
  // return new_doc_ref.id;

  return pnl_doc_ref;
}

function convertOperationToText(ops: number): string {
  if (ops === 1) return "add";
  if (ops === -1) return "sub";

  return "???";
}

function addValueArrays(arr1: number[], arr2: number[], arr2ops: number): number[] {
  if (arr1.length !== arr2.length) {
    throw new Error("Attempting to add two arrays of different length.");
  }

  for (const idx in arr1) {
    arr1[idx] += arr2[idx] * arr2ops;
  }

  return arr1;
}

function getEmptyValuesArray() {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}
