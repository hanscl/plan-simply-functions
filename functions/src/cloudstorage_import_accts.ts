import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as entity_model from "./entity_model";

const db = admin.firestore();

enum RunMode {
  Exclude,
  Include,
}

type acctRow = {
  [k: string]: string;
};

export const importAccountsFromCsv = functions.storage
  .object()
  .onFinalize(async (object) => {
    try {
      const bucket = admin.storage().bucket(object.bucket);
      const filePath = object.name;
      const fileName = filePath?.split("/").pop();

      if (fileName === undefined || filePath === undefined)
        throw new Error("could not extract filename");

      console.log(`File upload detected: ${fileName}`);

      // filename format: acct-[incl|excl]-ENTID1^ENTID2^ENTIDn.csv

      // Attempt to parse file name and confirm that the file uploaded was an account file
      const file_without_ext = fileName.split(".")[0];
      const parts = file_without_ext.split("-");
      if (parts.length !== 3 || parts[0] !== "accts") {
        console.log("this file is not for me :(");
        return;
      }

      const entity_ids = parts[2].split("^");

      const run_for_entity: RunMode =
        parts[1].toLowerCase() === "incl" ? RunMode.Include : RunMode.Exclude;

      if (run_for_entity === RunMode.Include)
        console.log(`Uploading Accounts for entities: ${entity_ids}`);
      else
        console.log(`Uploading Accounts for all entities except ${entity_ids}`);

      // load csv into memory
      const csv = require("csv-parser");
      const stripBom = require("strip-bom-stream");
      const all_acct_rows: acctRow[] = [];
      const stream = bucket
        .file(filePath)
        .createReadStream()
        .pipe(stripBom())
        .pipe(csv())
        .on("data", (data: acctRow) => all_acct_rows.push(data));

      await new Promise((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      });

      // print
      console.log(`Account Matrix loaded: ${JSON.stringify(all_acct_rows)}`);

      // process entities
      const entities_snap = await db
        .collection(`entities`)
        .where("type", "==", "entity")
        .get();
      if (entities_snap.empty) throw new Error("No entities found");

      for (const entity_doc of entities_snap.docs) {
        const entity_obj = entity_doc.data() as entity_model.entityDoc;
        // only process relevant entity(ies)
        if (
          run_for_entity === RunMode.Include &&
          !entity_ids.includes(entity_doc.id)
        ) {
          console.log(`Skipping entity ${entity_doc.id}`);
          continue;
        }
        if (
          run_for_entity === RunMode.Exclude &&
          entity_ids.includes(entity_doc.id)
        ) {
          console.log(`Skipping entity ${entity_doc.id}`);
          continue;
        }
        console.log(`Processing entity ${entity_doc.id}`);
        console.log(`Evaluating Entity entity ${entity_doc.id}`);
        // loop through the departments of this entity
        const dept_snap = await db
          .doc(`entities/${entity_doc.id}/entity_structure/dept`)
          .get();
        if (!dept_snap.exists) continue;
        const dept_dict = dept_snap.data() as entity_model.deptDict;
        const dept_list = Object.keys(dept_dict);

        // load rollup document
        const rollup_snap = await db
          .doc(`entities/${entity_doc.id}/entity_structure/rollup`)
          .get();
        if (!rollup_snap.exists)
          throw new Error(
            "Rollup document does not exist for this entity - EXITING"
          );
        const rollup_name_dicts = (rollup_snap.data() as entity_model.rollupSummaryDoc)
          .items;

        const acct_dict: entity_model.acctDict = {};

        for (const acct_row of all_acct_rows) {
          // filter the correct rollup name entry
          const fltrd_rollup_names = rollup_name_dicts.filter(
            (rollup_name_entry) =>
              rollup_name_entry.name === acct_row["Classification"]
          );
          if (fltrd_rollup_names.length === 0) {
            console.log(
              `could not find rollup name mapping for ${acct_row["Classification"]}`
            );
            continue;
          }
          // create dict entry for account
          acct_dict[acct_row["GL"]] = {
            name: acct_row["Description"],
            type: fltrd_rollup_names[0].code,
            depts: [],
          };

          for (const dept_id of dept_list) {
            // strip company number off department code
            const dept_id_no_cmp = dept_id.replace(entity_obj.number, "");
            if (
              acct_row[dept_id_no_cmp] !== undefined &&
              acct_row[dept_id_no_cmp].toLowerCase() === "x"
            )
              acct_dict[acct_row["GL"]].depts.push(dept_id);

            // Creating account
            // console.log(
            //   `ENTITY:DEPT ${entity_doc.id}:${dept_id} -- Creating account ${acct_matrix_row["Description"]} with G/L ${acct_matrix_row["GL"]} and Classification ${acct_matrix_row["Classification"]}`
            // );
          }
        }
        console.log(
          `Acct dict for entity ${entity_doc.id} READY: ${JSON.stringify(
            acct_dict
          )}`
        );
      }
    } catch (error) {
      console.log("Error occured after file uploaded to bucket: " + error);
      return;
    }
  });
