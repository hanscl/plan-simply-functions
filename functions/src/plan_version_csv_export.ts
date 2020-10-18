import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as fs from "fs-extra";
//import * as gcs from "@google-cloud/storage";

import * as path from "path";
import * as os from "os";
import * as json2csv from "json2csv";
import * as export_model from "./export_model";
import * as entity_model from "./entity_model";
import * as plan_model from "./plan_model";
import * as utils from "./utils";

const db = admin.firestore();

interface contextParams {
  entity_id: string;
  report_id: string;
}

export const exportPlanVersionToCsv = functions.firestore
  .document("entities/{entityId}/reports/{reportId}")
  .onCreate(async (snapshot, context) => {
    try {
      const context_params: contextParams = {
        entity_id: context.params.entityId,
        report_id: context.params.reportId,
      };

      const report_definition = snapshot.data() as export_model.reportDoc;

      // update the report-definition
      const plan_snap = await db
        .doc(
          `entities/${context_params.entity_id}/plans/${report_definition.plan_id}`
        )
        .get();
      if (plan_snap.exists)
        report_definition.plan_name = (plan_snap.data() as plan_model.planDoc).name;
      const version_snap = await plan_snap.ref
        .collection(`versions`)
        .doc(report_definition.version_id)
        .get();
      if (version_snap.exists)
        report_definition.version_name = (version_snap.data() as plan_model.versionDoc).name;

      // if the entity is a rollup, create reports for sub entities
      const entity_snap = await db
        .doc(`entities/${context_params.entity_id}`)
        .get();
      if (!entity_snap.exists)
        throw new Error(
          `Unexpected error: unable to find entity doc for ${context_params.entity_id}`
        );

      const entity = entity_snap.data() as entity_model.entityDoc;

      if (entity.type === "rollup") {
        await processRollupEntity(entity, report_definition);
        await snapshot.ref.delete();
        return;
      }

      // update the report -definition in the database
      await snapshot.ref.update(report_definition);

      const file_name = `reports/${context_params.report_id}.csv`;
      const temp_file_path = path.join(os.tmpdir(), file_name);

      // const gcs = require("@google-cloud/storage");
      //const storage = gcs.bucket(`csvexport-${admin.app().options.projectId}`);
      const bucket = admin
        .storage()
        .bucket(`csvexport-${admin.app().options.projectId}`);

      const data = await buildReportJson(context_params, report_definition);
      // console.log(`json data: ${JSON.stringify(data)}`);
      const csv_data = json2csv.parse(data);
      // console.log(`csv data: ${JSON.stringify(csv_data)}`);
      await fs.outputFile(temp_file_path, csv_data);

      await bucket.upload(temp_file_path, { destination: file_name });
      // storage.upload(temp_file_path, { destination: file_name });

      await snapshot.ref.update({ status: "complete" });
      fs.unlinkSync(temp_file_path);
    } catch (error) {
      console.log(
        `Error occured while exporting Plan-Version to CSV: ${error}`
      );
      await snapshot.ref.update({ status: "error" });
    }
  });

async function processRollupEntity(
  rollup_entity: entity_model.entityDoc,
  rollup_report: export_model.reportDoc
) {
  if (rollup_entity.children === undefined)
    throw new Error(
      `Rollup entity #${rollup_entity.number} does not have any children`
    );

  for (const child_id of rollup_entity.children) {
    // find the correct plan version
    const plan_snap = await db
      .collection(`entities/${child_id}/plans`)
      .where("name", "==", rollup_report.plan_name)
      .get();
    if (plan_snap.empty) {
      console.log(
        `Plan ${rollup_report.plan_name} not found for child entity ${child_id}. Skipping report for entity`
      );
      return;
    }
    const version_snap = await plan_snap.docs[0].ref
      .collection("versions")
      .where("name", "==", rollup_report.version_name)
      .get();
    if (version_snap.empty) {
      console.log(
        `Version ${rollup_report.version_name} not found for child entity ${child_id}. Skipping report for entity`
      );
      return;
    }
    // create report for child entity
    const child_report: export_model.reportDoc = {
      created_at: admin.firestore.Timestamp.now(),
      output: rollup_report.output,
      plan_id: plan_snap.docs[0].id,
      plan_name: rollup_report.plan_name,
      version_id: version_snap.docs[0].id,
      version_name: rollup_report.version_name,
      status: "processing",
      type: rollup_report.type,
    //  user_id: rollup_report.user_id,
    };

    // save to firestore
    await db.collection(`entities/${child_id}/reports`).add(child_report);
  }
}

async function buildReportJson(
  context_params: contextParams,
  report_definition: export_model.reportDoc
): Promise<export_model.acctExportCsv[]> {
  // load the entity doc
  const entity_snap = await db
    .doc(`entities/${context_params.entity_id}`)
    .get();
  if (!entity_snap.exists)
    throw new Error(
      `buildReportJson >> No entity doc found for entity ${context_params.entity_id}. Aborting function`
    );

  const entity = entity_snap.data() as entity_model.entityDoc;

  // Load the chart of accounts

  const coa_snap = await db
    .doc(`entities/${context_params.entity_id}/entity_structure/acct`)
    .get();
  if (!coa_snap.exists)
    throw new Error(
      `buildReportJson >> No account doc found for entity ${context_params.entity_id}. Aborting function`
    );

  const acct_dict = coa_snap.data() as entity_model.acctDict;

  const report_obj: export_model.acctExportCsv[] = [];

  // load all accounts from this version
  const version_accts: plan_model.accountDoc[] = [];
  const acct_version_snap = await entity_snap.ref
    .collection(
      `plans/${report_definition.plan_id}/versions/${report_definition.version_id}/dept`
    )
    .get();
  for (const acct_doc of acct_version_snap.docs) {
    version_accts.push(acct_doc.data() as plan_model.accountDoc);
  }

  // all accounts in version
  console.log(`all accounts in version: ${JSON.stringify(version_accts)}`);

  // load the dept dict as well
  const dept_snap = await entity_snap.ref
    .collection(`entity_structure`)
    .doc(`dept`)
    .get();
  if (!dept_snap.exists) throw new Error("Dept definition doc not found");

  const dept_dict = dept_snap.data() as entity_model.deptDict;

  for (const acct_id of Object.keys(acct_dict).sort()) {
    for (const dept_id of acct_dict[acct_id].depts) {
      // console.log(`executing acct-dept combo: ${acct_id}:${dept_id}`);
      const dept_obj = dept_dict[dept_id];
      if(dept_obj === undefined) {
        console.log(`Unable to locate dept ${dept_id} in dept dictionary - at acct ${JSON.stringify(acct_id)}`);
        continue;
      }
      const div_id = dept_obj.div;
      if (div_id === undefined) {
        console.log(`Unable to locate div in dept obj ${JSON.stringify(dept_obj)} dictionary`);
        continue;
      }
      const full_account = utils.buildFullAccountString([entity.full_account], {
        dept: dept_id,
        acct: acct_id,
        div: div_id,
      });

      // Create the basic CSV_line
      const csv_line: export_model.acctExportCsv = {
        company: entity.number,
        cost_center: dept_id,
        full_account: utils.buildFixedAccountString(
          entity.full_account_export,
          { dept: dept_id, acct: acct_id }
        ),
        gl_acct: acct_id,
        gl_name: acct_dict[acct_id].name,
      };

      // create empty values array
      let values_arr = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

      //  console.log(`full_account returned: ${full_account}`);
      const fltrd_version_accts = version_accts.filter((acct_obj) => {
        return acct_obj.full_account === full_account;
      });

      if (fltrd_version_accts.length > 0) {
        values_arr = fltrd_version_accts[0].values;
      }

      csv_line.p01 = values_arr[0];
      csv_line.p02 = values_arr[1];
      csv_line.p03 = values_arr[2];
      csv_line.p04 = values_arr[3];
      csv_line.p05 = values_arr[4];
      csv_line.p06 = values_arr[5];
      csv_line.p07 = values_arr[6];
      csv_line.p08 = values_arr[7];
      csv_line.p09 = values_arr[7];
      csv_line.p10 = values_arr[9];
      csv_line.p11 = values_arr[10];
      csv_line.p12 = values_arr[11];

      report_obj.push(csv_line);
    }
  }
  // console.log(`report obj before return: ${JSON.stringify(report_obj)}`);

  return report_obj;
}
