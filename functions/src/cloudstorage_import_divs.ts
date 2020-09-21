import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as entity_model from "./entity_model";

const db = admin.firestore();

interface div_row {
  code: string;
  name: string;
  depts: string;
  depts_arr?: string[];
}

export const importDivisionsFromCsv = functions.storage
  .object()
  .onFinalize(async (object) => {
    try {
      const bucket = admin.storage().bucket(object.bucket);
      const filePath = object.name;
      const fileName = filePath?.split("/").pop();

      if (fileName === undefined || filePath === undefined)
        throw new Error("could not extract filename");

      console.log(`File upload detected: ${fileName}`);

      // Attempt to parse file name and confirm that the file uploaded was a dept file
      const file_without_ext = fileName.split(".")[0];
      if (file_without_ext !== "divs") {
        console.log("this file is not for me :(");
        return;
      }

      const csv = require("csv-parser");
      const div_rows: div_row[] = [];
      const stream = bucket
        .file(filePath)
        .createReadStream()
        .pipe(csv())
        .on("data", (data: div_row) => div_rows.push(data));

      await new Promise((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      });

      // split the array for each
      div_rows.forEach((row) => {
        row.depts_arr = row.depts.split(" ");
      });

      // loop through all entities
      const entities_snap = await db.collection(`entities`).get();
      if (entities_snap.empty) throw new Error("no entities found");
      for (const entity_doc of entities_snap.docs) {
        const entity_obj = entity_doc.data() as entity_model.entityDoc;

        // get the dept doc
        const dept_snap = await entity_doc.ref
          .collection(`entity_structure`)
          .doc(`dept`)
          .get();
        if (!dept_snap.exists) {
          console.log(`No dept doc found for entity ${entity_doc.id}`);
          continue;
        }
        const dept_dict = dept_snap.data() as entity_model.deptDict;

        const div_dict: entity_model.divDict = {};
        // loop through all divisions and entities. Update the dept
        div_rows.forEach((div_map) => {
          // initialize div map
          div_dict[div_map.code] = {
            name: div_map.name,
            depts: [],
          };
          // try to update dept and add to div array
          if (div_map.depts_arr !== undefined) {
            for (const dept_code of div_map.depts_arr) {
              const dept_id = `${dept_code}${entity_obj.number}`;
              if (dept_dict[dept_id] !== undefined) {
                dept_dict[dept_id].div = div_map.code;
                div_dict[div_map.code].depts.push(dept_id);
              }
            }
          }
          // remove divs without depts
          if (div_dict[div_map.code].depts.length === 0) {
            delete div_dict[div_map.code];
          }
        });

        console.log(
          `For entity ${entity_doc.id} :: DIV = ${JSON.stringify(
            div_dict
          )} :: DEPT = ${JSON.stringify(dept_dict)}`
        );

        // set the documents
        await entity_doc.ref
          .collection("entity_structure")
          .doc("dept")
          .set(dept_dict);
        await entity_doc.ref
          .collection("entity_structure")
          .doc("div")
          .set(div_dict);
      }
    } catch (error) {
      console.log("Error occured after file uploaded to bucket: " + error);
      return;
    }
  });
