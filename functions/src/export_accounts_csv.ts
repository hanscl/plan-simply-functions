import * as admin from "firebase-admin";
import * as fs from "fs-extra";
import * as json2csv from "json2csv";
import * as export_model from "./export_model";
import * as entity_model from "./entity_model";
import * as plan_model from "./plan_model";
import * as utils from "./utils";

const db = admin.firestore();

export async function exportAccountsToCsv(path: string, report_params: export_model.reportRequest) {
  try {
    //     if (plan_snap.exists)
    //     report_definition.plan_name = (plan_snap.data() as plan_model.planDoc).name;
    //   const version_snap = await plan_snap.ref
    //     .collection(`versions`)
    //     .doc(report_definition.version_id)
    //     .get();
    //   if (version_snap.exists)
    //     report_definition.version_name = (version_snap.data() as plan_model.versionDoc).name;

    //   // if the entity is a rollup, create reports for sub entities
    //   const entity_snap = await db
    //     .doc(`entities/${context_params.entity_id}`)
    //     .get();
    //   if (!entity_snap.exists)
    //     throw new Error(
    //       `Unexpected error: unable to find entity doc for ${context_params.entity_id}`
    //     );

    //   const entity = entity_snap.data() as entity_model.entityDoc;

    //   if (entity.type === "rollup") {
    //     await processRollupEntity(entity, report_definition);
    //     await snapshot.ref.delete();
    //     return;
    //   }

    //   // update the report -definition in the database
    //   await snapshot.ref.update(report_definition);

    const data = await buildReportJson(report_params);

    if(data === undefined) throw new Error(`BuildJsonDidNotReportData`);
    console.log(`back from buildJson`);
    console.log(`json data: ${JSON.stringify(data)}`);

    const csv_data = json2csv.parse(data);
    // console.log(`csv data: ${JSON.stringify(csv_data)}`);

    await fs.outputFile(path, csv_data);
    return;
  } catch (error) {
    console.log(`Error occured while exporting Plan-Version to CSV: ${error}`);
  }
}

async function buildReportJson(report_params: export_model.reportRequest): Promise<export_model.acctExportCsv[] | undefined> {
  try { 
    console.log(`Starting buildReportJson`);
    console.log(`report params ${report_params}`);
    // load the entity doc
    const entity_snap = await db.doc(`entities/${report_params.entity_id}`).get();
    if (!entity_snap.exists) throw new Error(`buildReportJson >> No entity doc found for entity ${report_params.entity_id}. Aborting function`);

    const entity = entity_snap.data() as entity_model.entityDoc;

    // Load the chart of accounts

    const coa_snap = await db.doc(`entities/${report_params.entity_id}/entity_structure/acct`).get();
    if (!coa_snap.exists) throw new Error(`buildReportJson >> No account doc found for entity ${report_params.entity_id}. Aborting function`);

    const acct_dict = coa_snap.data() as entity_model.acctDict;

    const report_obj: export_model.acctExportCsv[] = [];

    // load all accounts from this version
    const version_accts: plan_model.accountDoc[] = [];
    const acct_version_snap = await entity_snap.ref.collection(`plans/${report_params.plan_id}/versions/${report_params.version_id}/dept`).get();
    for (const acct_doc of acct_version_snap.docs) {
      version_accts.push(acct_doc.data() as plan_model.accountDoc);
    }

    // all accounts in version
    console.log(`all accounts in version: ${JSON.stringify(version_accts)}`);

    // load the dept dict as well
    const dept_snap = await entity_snap.ref.collection(`entity_structure`).doc(`dept`).get();
    if (!dept_snap.exists) throw new Error("Dept definition doc not found");

    const dept_dict = dept_snap.data() as entity_model.deptDict;

    for (const acct_id of Object.keys(acct_dict).sort()) {
      for (const dept_id of acct_dict[acct_id].depts) {
        // console.log(`executing acct-dept combo: ${acct_id}:${dept_id}`);
        const dept_obj = dept_dict[dept_id];
        if (dept_obj === undefined) {
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
          full_account: utils.buildFixedAccountString(entity.full_account_export, { dept: dept_id, acct: acct_id }),
          gl_acct: acct_id,
          gl_name: acct_dict[acct_id].name,
        };

        // create empty values array
        let values_arr = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

       // console.log(`full_account returned: ${full_account}`);
        const fltrd_version_accts = version_accts.filter((acct_obj) => {
          return acct_obj.full_account === full_account;
        });

        // TODO - fix hardcoding REV_TTL
        let multiplier = 1;
        if (fltrd_version_accts.length > 0) {
          values_arr = fltrd_version_accts[0].values;
          //console.log(`found matching account in version: ${JSON.stringify(fltrd_version_accts)}`);
          if (fltrd_version_accts[0].acct_type !== "REV_TTL" && fltrd_version_accts[0].acct_type !== "STATS") multiplier = -1;
        }

        csv_line.p01 = values_arr[0] * multiplier;
        csv_line.p02 = values_arr[1] * multiplier;
        csv_line.p03 = values_arr[2] * multiplier;
        csv_line.p04 = values_arr[3] * multiplier;
        csv_line.p05 = values_arr[4] * multiplier;
        csv_line.p06 = values_arr[5] * multiplier;
        csv_line.p07 = values_arr[6] * multiplier;
        csv_line.p08 = values_arr[7] * multiplier;
        csv_line.p09 = values_arr[8] * multiplier;
        csv_line.p10 = values_arr[9] * multiplier;
        csv_line.p11 = values_arr[10] * multiplier;
        csv_line.p12 = values_arr[11] * multiplier;

        report_obj.push(csv_line);
      }
    }
    console.log(`report obj before return: ${JSON.stringify(report_obj)}`);

    return report_obj;
  } catch (error) {
    console.log(`Error in buildJsonReport: ${error}`);
    return undefined;
  }
}
