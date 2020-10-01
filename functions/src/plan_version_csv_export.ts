import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as fs from "fs-extra";
//import * as gcs from "@google-cloud/storage";
const gcs = require("@google-cloud/storage")();

import * as path from "path";
import * as os from "os";
import * as json2csv from "json2csv";

const db = admin.firestore();

interface contextParams {
  report_id: string;
}

export const exportPlanVersionToCsv = functions.firestore
  .document("entities/{entityId}/reports/{reportId}")
  .onCreate(async (snapshot, context) => {
    try {
      const context_params: contextParams = {
        report_id: context.params.reportId,
      };

      const file_name = `reports/${context_params.report_id}`;
      const temp_file_path = path.join(os.tmpdir(), file_name);

      const storage = gcs.bucket(`csvexport-${admin.app().options.projectId}`);

      const data = {};
      const csv_data = json2csv.parse(data);

      await fs.outputFile(temp_file_path, csv_data);

      storage.upload(temp_file_path, { destination: file_name });

      snapshot.ref.update({ status: "complete" });
    } catch (error) {
      console.log(
        `Error occured while exporting Plan-Version to CSV: ${error}`
      );
      snapshot.ref.update({ status: "error" });
    }
  });
