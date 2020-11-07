import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as https_utils from "./https_utils";
import * as config from "./config";
import * as path from "path";
import * as os from "os";
import * as fs from "fs-extra";
import * as user_model from "./user_model";
import * as plan_model from "./plan_model";
import * as nodemailer from "nodemailer";
import * as export_accounts from "./export_accounts_csv";

const cors = require("cors")({ origin: true });
const key = require("../alert-condition-291223-fe5b366c5ed9.json");

const db = admin.firestore();

interface ExportRequest {
  action: "export" | "init";
  plan?: string;
  version?: string;
}

interface PlanVersionMapping {
  plans: string[];
  plan_versions: { plan: string; version: string }[];
}

interface FilePathName {
  filename: string;
  path: string;
}

export const exportPlanVersionCsv = functions.region(config.cloudFuncLoc).https.onRequest(async (request, response) => {
  cors(request, response, async () => {
    try {
      response.set("Access-Control-Allow-Origin", "*");
      response.set("Access-Control-Allow-Credentials", "true");

      if (request.method === "OPTIONS") {
        response.set("Access-Control-Allow-Methods", "GET");
        response.set("Access-Control-Allow-Headers", "Authorization");
        response.set("Access-Control-Max-Age", "3600");
        response.status(204).send("");

        return;
      }

      const authToken = https_utils.validateHeader(request); // current user encrypted

      if (!authToken) {
        response.status(403).send("Unauthorized! Missing auth token!");
        return;
      }

      const dec_token = await https_utils.decodeAuthToken(authToken);

      if (dec_token === undefined) {
        response.status(403).send("Invalid token.");
        return;
      }

      console.log(`uid: ${dec_token}`);

      const user_snap = await db.doc(`users/${dec_token}`).get();
      if (!user_snap.exists) {
        response.status(403).send("User not known in this system!");
        return;
      }

      const bulkExportRequest = request.body as ExportRequest;
      if (bulkExportRequest.action === "init") {
        const planVersions = await getAllPlanVersions();
        console.log(`found plan versions: ${JSON.stringify(planVersions)}`);
        response.status(200).send(planVersions);
      } else {
        const files: FilePathName[] = [];

        // make sure the request body looks good :)
        if (bulkExportRequest.action !== "export" || bulkExportRequest.plan === undefined || bulkExportRequest.version === undefined)
          throw new Error("Invalid request body.");

        const exportPromises: Promise<any>[] = [];
        const entSnap = await db.collection("entities").where("type", "==", "entity").get();
        for (const entDoc of entSnap.docs) {
          const planSnap = await entDoc.ref.collection("plans").where("name", "==", bulkExportRequest.plan).get();

          for (const planDoc of planSnap.docs) {
            const versionSnap = await planDoc.ref.collection("versions").where("name", "==", bulkExportRequest.version).get();

            for (const versionDoc of versionSnap.docs) {
              const file_name = `${entDoc.id}_Accounts_${versionDoc.id}.csv`;
              const file_path = path.join(os.tmpdir(), file_name);
              files.push({ filename: file_name, path: file_path });
              // run all reports synchronously
              console.log(`STARTING export #${files.length}`);
              exportPromises.push(
                export_accounts.exportAccountsToCsv(file_path, {
                  entity_id: entDoc.id,
                  output: "csv",
                  plan_id: planDoc.id,
                  version_id: versionDoc.id,
                })
              );
            }
          }
        }

        // now wait until all promises are resolved
        await Promise.all(exportPromises);

        const subject = `Multiple Property Accounts CSV Reports`;

        //get user email
        const email = (user_snap.data() as user_model.userDoc).email;
        await emailReport(email, subject, files);

        for (const fileItem of files) fs.unlinkSync(fileItem.path);
        response.status(200).send({ result: `Report email dispatched.` });
      }
    } catch (error) {
      console.log(`Error occured during bulk csv export: ${error}`);
      response.status(500).send({ result: `Error sending report. Please contact support` });
    }
  });
});

async function emailReport(user_email: string, subject: string, files: FilePathName[]) {
  const support_send_email = "noreply@zerobaseapp.com";
  const mailOptions = {
    from: support_send_email,
    to: user_email,
    subject: subject, // email subject
    html: `Hello,<br><br>Attached please find the report(s) you requested<br><br>
    Your ZeroBase Support team`, // email content in HTML
    attachments: files,
  };

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      type: "OAuth2",
      user: support_send_email,
      serviceClient: key.client_id,
      privateKey: key.private_key,
    },
  });

  try {
    await transporter.verify();
    await transporter.sendMail(mailOptions);
  } catch (error) {
    `Error occured sending mail: ${JSON.stringify(error)}`;
  }
}

async function getAllPlanVersions(): Promise<PlanVersionMapping> {
  try {
    const planVersionsMap: PlanVersionMapping = { plans: [], plan_versions: [] };
    const entSnap = await db.collection(`entities`).where("type", "==", "entity").get();

    for (const entDoc of entSnap.docs) {
      const planSnap = await entDoc.ref.collection("plans").get();

      for (const planDoc of planSnap.docs) {
        const planName = (planDoc.data() as plan_model.planDoc).name;

        // filter existing plans
        const fltrdPlans = planVersionsMap.plans.filter((plan) => {
          return plan === planName;
        });

        // add new if it doesn't exist
        if (fltrdPlans.length === 0) planVersionsMap.plans.push(planName);

        // proceed to find versions for this plan
        const versionSnap = await planDoc.ref.collection("versions").get();
        for (const versionDoc of versionSnap.docs) {
          const versionName = (versionDoc.data() as plan_model.versionDoc).name;

          // filter exisiting plan-version combinations
          const fltrdVersions = planVersionsMap.plan_versions.filter((planVersionCombo) => {
            return planVersionCombo.plan === planName && planVersionCombo.version === versionName;
          });

          // add new combo if it doesn't exist
          if (fltrdVersions.length === 0) planVersionsMap.plan_versions.push({ plan: planName, version: versionName });
        }
      }
    }

    return planVersionsMap;
  } catch (error) {
    throw new Error(`Error occurred while obtaining all plan version combinations: ${error}`);
  }
}
