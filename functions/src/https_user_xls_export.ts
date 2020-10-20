import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as https_utils from "./https_utils";
import * as export_model from "./export_model";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import * as user_model from "./user_model";
import * as nodemailer from "nodemailer";
import * as xls from "excel4node";
const cors = require("cors")({ origin: true });
const key = require("../alert-condition-291223-fe5b366c5ed9.json");

const db = admin.firestore();

export const processXlsExportRequest = functions.https.onRequest(async (request, response) => {
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

      const xls_request = request.body as export_model.reportDoc;

      const wb = new xls.Workbook();
      var inc_ws = wb.addWorksheet("Sheet 1");
      var labor_ws = wb.addWorksheet("Sheet 1");

      // Create a reusable style
      var style = wb.createStyle({
        font: {
          color: "#FF0800",
          size: 10,
        },
        numberFormat: "$#,##0.00; ($#,##0.00); -",
      });

      // Set value of cell A1 to 100 as a number type styled with paramaters of style
      inc_ws.cell(1, 1).number(100).style(style);

      // Set value of cell A2 to 'string' styled with paramaters of style
      labor_ws.cell(1, 1).string("string").style(style);

      const file_name = "test.csv";
      const temp_file_path = path.join(os.tmpdir(), file_name);
      await wb.write(temp_file_path);
      await fs.outputFile(temp_file_path, JSON.stringify(xls_request));

      // get user email
      const email = (user_snap.data() as user_model.userDoc).email;

      console.log(`Emailing XLS reports to ${email} -- ${JSON.stringify(xls_request)}`);
      await emailReport(email, temp_file_path);

      // createPlanXls();
      // createLaborXls();
      // emailReports();

      response.status(200).send({ result: `Report email dispatched.` });
    } catch (error) {
      console.log(`Error occured whil generating excel report: ${error}`);
      response.status(500).send({ result: `Error sending report. Please contact support` });
    }
  });
});

async function emailReport(user_email: string, file_path: string) {
  const support_send_email = "noreply@zerobaseapp.com";
  const mailOptions = {
    //from: "ZeroBase Support <noreply@zerobaseapp.com>",
    from: support_send_email,
    to: user_email,
    subject: "ZeroBase Excel Report", // email subject
    html: `Hello,<br><br>Attached please find the report you requested<br><br>
    Your ZeroBase Support team`, // email content in HTML
    attachments: [
      {
        // file on disk as an attachment
        filename: "report.csv",
        path: file_path, // stream this file
      },
    ],
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

  await transporter.verify();
  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      throw new Error(`Error occured sending mail: ${JSON.stringify(error)}`);
    }
  });
}
