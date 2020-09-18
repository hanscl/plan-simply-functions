import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

enum RollDirection {
  Div_fromDivToDeptOrGroup,
  Dept_fromGroupToDept,
  Dept_fromRollupToRollup,
  Dept_fromRollupToAcct,
  Dept_None,
}

interface accountDoc {
  acct: string;
  acct_name: string;
  acct_type?: string;
  class: string;
  dept?: string;
  div: string;
  divdept_name: string;
  group: boolean;
  full_account: string;
  parent_rollup?: parentRollup;
  total: number;
  values: number[];
  group_children?: string[];
  is_group_child: boolean;
}

interface versionDoc {
  last_update: admin.firestore.Timestamp;
  name: string;
  number: number;
  calculated: boolean;
  pnl_structure_id: string;
  ready_for_view?: boolean;
}

interface pnlStructure {
  sections: pnlSection[];
}

interface pnlSection {
  name: string;
  header: boolean;
  total: boolean;
  lines: boolean;
  skip_levels?: number;
  filters: pnlDivFilter[];
}

interface pnlDivFilter {
  div: string[];
  rollup: string;
  operation: number;
}

interface viewDoc {
  periods: viewPeriod[];
  plan_id: string;
  pnl_structure_id: string;
  title: string;
  total: viewTotal;
  version_id?: string;
}

interface viewTotal {
  long: string;
  short: string;
}

interface viewPeriod {
  long: string;
  number: number;
  short: string;
}

interface parentRollup {
  acct: string;
  operation: number;
}

interface contextParams {
  entityId: string;
  planId: string;
  versionId: string;
  n_level_rollups: string[];
}

interface planDoc {
  account_rollup: string;
  begin_month: number;
  begin_year: number;
  created: admin.firestore.Timestamp;
  name: string;
  periods: viewPeriod[];
  total: viewTotal;
  type: string;
}

interface accountForSection {
  operation: number;
  account: accountDoc;
}

interface pnlAggregateDoc {
  child_accts: string[];
  child_ops: number[];
  total: number;
  values: number[];
  view_id: string;
}

interface viewSection {
  name: string;
  header: boolean;
  position: number;
  totals_level?: string;
  totals_id?: string;
  lines?: viewChild[];
}

interface viewChild {
  level: string;
  acct: string;
  desc: string;
  child_accts?: viewChild[];
}

interface rollupDefDoc {
  acct_types?: string[];
  accts_add?: string[];
  accts_remove?: string[];
  child_rollups?: any;
  level: number;
  n_level: boolean;
  rollup: string;
}

type viewSectionDict = {
  [k: string]: viewSection;
};

type sectionDocRefDict = {
  [k: string]: FirebaseFirestore.DocumentReference;
};

interface entityDoc {
  acct_type_flip_sign: string[];
  full_account: string;
  full_account_export: string;
  legal: string;
  name: string;
  number: string;
  type: string;
}
const db = admin.firestore();

export const planViewGenerate = functions.firestore
  .document("entities/GEAMS/plans/{planId}/versions/{versionId}")
  .onUpdate(async (snapshot, context) => {
    try {
      const version_before = snapshot.before.data() as versionDoc;
      const version_after = snapshot.after.data() as versionDoc;
      const context_params: contextParams = {
        entityId: "GEAMS",
        planId: context.params.planId,
        versionId: context.params.versionId,
        n_level_rollups: [],
      };

      console.log(
        "processing GEAMS view generate => if ready_for_view from FALSE to TRUE THEN proceed"
      );

      // Process only if the version was recalculated
      if (
        version_after.ready_for_view === false ||
        version_before.ready_for_view === version_after.calculated
      ) {
        return;
      }

      // Get entity number ...
      const entity_snap = await db.doc(`entities/${context_params.entityId}`).get();

      if(!entity_snap.exists) throw new Error('Could not find entity document for id: ' + context_params.entityId);

      const ent_no = (entity_snap.data() as entityDoc).number;

      // check if a view exists for this version; if so - delete before continuing
      // then create new plan view and write function for that
      const view_snapshots = await db
        .collection(`entities/${context_params.entityId}/views`)
        .where("plan_id", "==", context_params.planId)
        .where("version_id", "==", context_params.versionId)
        .get();

      view_snapshots.forEach(async (view_doc) => {
        const sect_snapshots = await view_doc.ref
        .collection(`by_org_level`)
        .get();
        sect_snapshots.forEach(async (sect_doc) =>  {
          await deleteCollection(sect_doc.ref.collection("sections"), 300);
        });
        await deleteCollection(view_doc.ref.collection("by_org_level"), 300);
        await view_doc.ref.delete();
      });

      // delete the pnl collection with the view aggregations
      await deleteCollection(
        db.collection(
          `entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/pnl`
        ),
        300
      );

      // Get the plan document to transfer total and period defs
      const plan_snapshot = await db
        .doc(
          `entities/${context_params.entityId}/plans/${context_params.planId}`
        )
        .get();

      if (!plan_snapshot.exists)
        throw new Error(
          "Could not find plan for view. Which is strange, because this function gets triggered by a plan version :-/"
        );

      const plan_obj = plan_snapshot.data() as planDoc;

      // Create a new view
      const new_view: viewDoc = {
        periods: plan_obj.periods,
        plan_id: context_params.planId,
        pnl_structure_id: version_after.pnl_structure_id,
        title: `${context_params.entityId} Income Statement`,
        total: plan_obj.total,
        version_id: context_params.versionId,
      };
      // ... & save to firestore
      const new_view_ref = await db
        .collection(`entities/${context_params.entityId}/views`)
        .add(new_view);

      // find n-level rollups
      const rollup_doc_snap = await db
        .collection(
          `entities/${context_params.entityId}/account_rollups/${plan_obj.account_rollup}/rollups`
        )
        .where("n_level", "==", true)
        .get();

      if (rollup_doc_snap.empty)
        throw new Error(
          "Unable to find any n-level rollup accounts, which should not be happening!"
        );

      for (const rollup_def_doc of rollup_doc_snap.docs) {
        const rollup_def_obj = rollup_def_doc.data() as rollupDefDoc;
        context_params.n_level_rollups.push(rollup_def_obj.rollup);
      }

      // load pnl structure doc
      const pnl_struct_snap = await db
        .doc(
          `entities/${context_params.entityId}/pnl_structures/${version_after.pnl_structure_id}`
        )
        .get();
      if (!pnl_struct_snap.exists)
        throw new Error(
          "Could not find P&L Structure definition with doc id: " +
            version_after.pnl_structure_id
        );
      const pnl_struct_obj = pnl_struct_snap.data() as pnlStructure;

      // get list of divs for the entity
      const div_snap = await db
        .doc(`entities/${context_params.entityId}/entity_structure/div`)
        .get();
      if (!div_snap.exists)
        throw new Error(
          "Could not find Divisions in Entity Structure collection"
        );
      const div_definitions = div_snap.data() as Record<string, object>;
      const div_list: string[] = Object.keys(div_definitions);

      let write_batch = db.batch();
      let write_ctr = 0;

      // create the org_level_docs and save the ids
      const cmp_view_doc_ref = await new_view_ref
        .collection("by_org_level")
        .add({ level: "company", filter: ent_no }); // TODO ADD CMP FILTER
      const div_view_doc_refs: sectionDocRefDict = {};
      for (const div_id of div_list) {
        div_view_doc_refs[div_id] = await new_view_ref
          .collection("by_org_level")
          .add({ level: "div", filter: div_id });
      }

      // Repeat the code below for each section
      for (
        let section_pos = 0;
        section_pos < pnl_struct_obj.sections.length;
        section_pos++
      ) {
        const sectionObj = pnl_struct_obj.sections[section_pos];
        // Get the list of divs for the filters
        const section_div_accts: accountForSection[] = [];
        for (const filterDef of sectionObj.filters) {
          const group_acct_snap = await db
            .collection(
              `entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/div`
            )
            .where("div", "in", filterDef.div)
            .where("acct", "==", filterDef.rollup)
            .get();

          if (group_acct_snap.empty) return;

          // save all div accts for this filter
          for (const acct_doc of group_acct_snap.docs) {
            section_div_accts.push({
              operation: filterDef.operation,
              account: acct_doc.data() as accountDoc,
            });
          }
        } // END Processing Filters from Section Document

        const pnl_doc_id = await createPnlAggregate(
          context_params,
          section_div_accts,
          new_view_ref.id
        );

        // Create section document for COMPANY & DIVs
        const cmp_view_sect: viewSection = {
          name: sectionObj.name,
          position: section_pos,
          header: sectionObj.header,
          totals_level: "pnl",
          totals_id: pnl_doc_id,
        };

        const div_view_sects = {} as viewSectionDict;
        for (const div_id of div_list) {
          // filter accounts by div id
          const fltrd_div_accts = section_div_accts.filter((acct_item) => {
            return acct_item.account.div === div_id;
          });

          // skip adding section if current div does not have any accounts in it
          if (fltrd_div_accts.length === 0) continue;

          // create view section and add to map object
          div_view_sects[div_id] = await createDivViewSections(
            sectionObj,
            section_pos,
            fltrd_div_accts,
            context_params,
            new_view_ref.id
          );
        }

        if (sectionObj.lines) {
          // we have lines to add; create array in this view section
          cmp_view_sect.lines = [];

          for (const div_line_acct of section_div_accts) {
            const curr_line: viewChild = {
              level: div_line_acct.account.dept !== undefined ? "dept" : "div",
              acct: div_line_acct.account.full_account,
              desc: div_line_acct.account.divdept_name,
            };
            // save to lines in parent
            cmp_view_sect.lines.push(curr_line);
            // ... and call the recursive function
            await rollDownLevelOrAcct(
              div_line_acct.account,
              curr_line,
              context_params,
              div_view_sects
            );
          }
        } // END processing lines for section object

        //TODO: Remove before PROD deployment
        console.log(
          `Section ${sectionObj.name} complete ....` +
            JSON.stringify(cmp_view_sect)
        );
        console.log(
          "Completed creating view sections for all DIVs: " +
            JSON.stringify(div_view_sects)
        );

        // Add to BATCH & intermittent write
        write_batch.set(
          cmp_view_doc_ref.collection("sections").doc(),
          cmp_view_sect
        );
        write_ctr++;
        for (const div_id of Object.keys(div_view_sects)) {
          write_batch.set(
            div_view_doc_refs[div_id].collection("sections").doc(),
            div_view_sects[div_id]
          );
          write_ctr++;
        }

        if(write_ctr > 400) {
          await write_batch.commit();
          write_batch = db.batch();
          write_ctr = 0;
        }
        

      } // END Processing Sections from PnL Structure

      if(write_ctr > 0) {
        await write_batch.commit();
      }

      return;
    } catch (error) {
      console.log(
        "Error occured during view generation (NEW - GEAMS) " + error
      );
      return;
    }
  });

async function createDivViewSections(
  section_obj: pnlSection,
  section_pos: number,
  fltrd_div_accts: accountForSection[],
  context_params: contextParams,
  view_id: string
): Promise<viewSection> {
  // setup basic object
  const div_view_sect: viewSection = {
    name: section_obj.name,
    header: section_obj.header,
    position: section_pos,
  };

  // if we have more than one account for this division => create a custom PNL aggregate
  // otherwise, just reference this div account
  if (fltrd_div_accts.length > 1) {
    div_view_sect.totals_level = "pnl";
    div_view_sect.totals_id = await createPnlAggregate(
      context_params,
      fltrd_div_accts,
      view_id
    );
  } else {
    div_view_sect.totals_level = "div";
    div_view_sect.totals_id = fltrd_div_accts[0].account.full_account;
  }

  return div_view_sect;
}

async function rollDownLevelOrAcct(
  parent_acct: accountDoc,
  parent_view_obj: viewChild,
  context_params: contextParams,
  div_sections: viewSectionDict
) {
  const rollDir: RollDirection = determineRollDirection(
    parent_acct,
    context_params.n_level_rollups
  );

  if (rollDir === RollDirection.Dept_None) return;

  // query the child accounts based on the rolldirection
  let child_acct_snap = undefined;
  const version_dept_ref = db.collection(
    `entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/dept`
  );
  if (rollDir === RollDirection.Div_fromDivToDeptOrGroup) {
    child_acct_snap = await version_dept_ref
      .where("div", "==", parent_acct.div)
      .where("acct", "==", parent_acct.acct)
      .where("is_group_child", "==", false)
      .get();
  } else if (rollDir === RollDirection.Dept_fromGroupToDept) {
    child_acct_snap = await version_dept_ref
      .where("full_account", "in", parent_acct.group_children)
      .get();
  }
  // TODO can this be handled indeed with one case? If so, remove n_level flag from rollups and remove query in this function, then consolidate flags
  else if (
    rollDir === RollDirection.Dept_fromRollupToRollup ||
    rollDir === RollDirection.Dept_fromRollupToAcct
  ) {
    child_acct_snap = await version_dept_ref
      .where("parent_rollup.acct", "==", parent_acct.acct)
      .where("dept", "==", parent_acct.dept)
      .get();
  }

  if (child_acct_snap === undefined || child_acct_snap.empty) {
    // TODO: remove before prod deployment
    // console.log(
    //   `No Child account found for operation ${rollDir}. Parent Account Object was: ` +
    //     JSON.stringify(parent_acct)
    // );
    return;
  }

  // we know the current account has children; create the array in the parent view object
  parent_view_obj.child_accts = [];

  for (const child_acct_doc of child_acct_snap.docs) {
    const child_acct = child_acct_doc.data() as accountDoc;
    // select descriptor for this child account
    const acct_desc = getLineDescription(child_acct, rollDir);
    // create new view
    const curr_child: viewChild = {
      level: child_acct.dept !== undefined ? "dept" : "div",
      acct: child_acct.full_account,
      desc: acct_desc,
    };

    // save this account to the array of child accts in the parent object
    parent_view_obj.child_accts.push(curr_child);

    // if we rolled down from DIV then the child needs to be added to the DIV view section as well
    if (rollDir === RollDirection.Div_fromDivToDeptOrGroup) {
      if (div_sections[child_acct.div].lines === undefined) {
        div_sections[child_acct.div].lines = [];
      }
      div_sections[child_acct.div].lines?.push(curr_child);
    }

    // recursively call this function with the current child
    await rollDownLevelOrAcct(
      child_acct,
      curr_child,
      context_params,
      div_sections
    );
  }
}

function getLineDescription(acct: accountDoc, rollDir: RollDirection): string {
  if (acct.class === "acct") {
    return `${acct.acct} - ${acct.acct_name}`;
  }

  if (
    rollDir === RollDirection.Div_fromDivToDeptOrGroup ||
    rollDir === RollDirection.Dept_fromGroupToDept
  ) {
    return acct.divdept_name;
  }

  if (
    rollDir === RollDirection.Dept_fromRollupToRollup ||
    rollDir === RollDirection.Dept_fromRollupToAcct
  ) {
    return acct.acct_name;
  }

  return "N/A";
}

function determineRollDirection(
  acct: accountDoc,
  n_level_rollups: string[]
): RollDirection {
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

async function createPnlAggregate(
  context_params: contextParams,
  div_accts: accountForSection[],
  view_id: string
): Promise<string> {
  const pnl_aggregate: pnlAggregateDoc = {
    child_accts: [],
    child_ops: [],
    total: 0,
    values: getEmptyValuesArray(),
    view_id: view_id,
  };
  for (const div_acct of div_accts) {
    pnl_aggregate.child_accts.push(div_acct.account.full_account);
    pnl_aggregate.child_ops.push(div_acct.operation);
    pnl_aggregate.total += div_acct.account.total * div_acct.operation;
    pnl_aggregate.values = addValueArrays(
      pnl_aggregate.values,
      div_acct.account.values,
      div_acct.operation
    );
  }

  const new_doc_ref = await db
    .collection(
      `entities/${context_params.entityId}/plans/${context_params.planId}/versions/${context_params.versionId}/pnl`
    )
    .add(pnl_aggregate);

  return new_doc_ref.id;
}

function addValueArrays(
  arr1: number[],
  arr2: number[],
  arr2ops: number
): number[] {
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

async function deleteCollection(
  collectionRef: FirebaseFirestore.CollectionReference<
    FirebaseFirestore.DocumentData
  >,
  batchSize: number
) {
  const query = collectionRef.orderBy("__name__").limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(query, resolve).catch(reject);
  });
}

async function deleteQueryBatch(
  query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>,
  resolve: any
) {
  const snapshot = await query.get();

  const batchSize = snapshot.size;
  if (batchSize === 0) {
    // When there are no documents left, we are done
    resolve();
    return;
  }

  // Delete documents in a batch
  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();

  // Recurse on the next process tick, to avoid
  // exploding the stack.
  process.nextTick(() => {
    deleteQueryBatch(query, resolve).catch();
  });
}
