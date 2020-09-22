import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as entity_model from "./entity_model";
//import * as gcs from "@google-cloud/storage";

const db = admin.firestore();
//const gcs = new Storage();

interface dept_row {
  code: string;
  name: string;
}

export const importDepartmentsFromCsv = functions.storage
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
      const parts = file_without_ext.split("-");
      if (parts.length !== 2 || parts[0] !== "depts") {
        console.log("this file is not for me :(");
        return;
      }

      const entity_id = parts[1];

      // load entity number
      const entity_snap = await db.doc(`entities/${entity_id}`).get();
      if(!entity_snap.exists) throw new Error("Entity not found");

      const entity_no = (entity_snap.data() as entity_model.entityDoc).number;

      if(entity_no === undefined) throw new Error("No entity number. cannot proceed");

      console.log(`Processing dept upload for entity ${parts[1]}`);

      const csv = require("csv-parser");
      const stripBom = require("strip-bom-stream");

      const dept_rows: dept_row[] = [];
      const stream = bucket
        .file(filePath)
        .createReadStream()
        .pipe(stripBom())
        .pipe(csv())
        .on("data", (data: dept_row) => dept_rows.push(data));

      await new Promise((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      });

      // create the dept dict
      const dept_doc: entity_model.deptDict = {};
      dept_rows.forEach((row) => {
        if (row.code !== undefined) {
          dept_doc[`${row.code}${entity_no}`] = {
            name: row.name,
          };
        }
      });

      console.log(`Adding document: ${JSON.stringify(dept_doc)}`);

      await db
        .doc(`entities/${entity_id}/entity_structure/dept`)
        .set(dept_doc, { merge: true });
    } catch (error) {
      console.log("Error occured after file uploaded to bucket: " + error);
      return;
    }
  });
