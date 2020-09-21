import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
//import * as gcs from "@google-cloud/storage";

const db = admin.firestore();
//const gcs = new Storage();

enum RunMode {
  All,
  Paris,
}

type acct_row = {
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

      // Attempt to parse file name and confirm that the file uploaded was an account file
      const file_without_ext = fileName.split(".")[0];
      const parts = file_without_ext.split("-");
      if (parts.length !== 2 || parts[0] !== "acct") {
        console.log("this file is not for me :(");
        return;
      }

      const run_for_entity: RunMode =
        parts[1] === "PAR" ? RunMode.Paris : RunMode.All;

      // load csv into memory

      const csv = require("csv-parser");
      const all_acct_rows: acct_row[] = [];
      const stream = bucket
        .file(filePath)
        .createReadStream()
        .pipe(csv())
        .on("data", (data: acct_row) => all_acct_rows.push(data));

      await new Promise((resolve, reject) => {
        stream.on("end", resolve);
        stream.on("error", reject);
      });

      // print
      console.log(`Account Matrix loaded: ${JSON.stringify(all_acct_rows)}`);

      // process entities
      const entities_snap = await db.collection(`entities`).get();
      if (entities_snap.empty) throw new Error("No entities found");

      for (const entity_doc of entities_snap.docs) {
        // only process relevant entity(ies)
        if (run_for_entity === RunMode.Paris && entity_doc.id !== "GEPAR")
          continue;
        if (run_for_entity === RunMode.All && entity_doc.id === "GEPAR")
          continue;
      }
    } catch (error) {
      console.log("Error occured after file uploaded to bucket: " + error);
      return;
    }
  });
