import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as https_utils from "./https_utils";
import * as export_model from "./export_model";
import * as fs from "fs-extra";
import * as path from "path";
import * as os from "os";
import * as user_model from "./user_model";
import * as nodemailer from "nodemailer";
const cors = require("cors")({ origin: true });
const key = require("../alert-condition-291223-fe5b366c5ed9.json");

const db = admin.firestore();


export const processXlsExportRequest = functions.https.onRequest(
  async (request, response) => {
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

        if(dec_token === undefined) {
          response.status(403).send("Invalid token.");
          return;
        }
    
        console.log(`uid: ${dec_token}`);

        const user_snap = await db.doc(`users/${dec_token}`).get();
        if(!user_snap.exists) {
          response.status(403).send("User not known in this system!");
          return;
        }

        const xls_request = request.body as export_model.reportDoc;
        const file_name = "test.csv";
        const temp_file_path = path.join(os.tmpdir(), file_name);
        await fs.outputFile(temp_file_path, JSON.stringify(xls_request));

        // get user email
        const email = (user_snap.data() as user_model.userDoc).email

        console.log(`Emailing XLS reports to ${email} -- ${JSON.stringify(xls_request)}`);
        await emailReport(email, temp_file_path);

        // createPlanXls();
        // createLaborXls();
        // emailReports();

        response.status(200).send({result: `Function completed successfully.`});
      } catch (error) {
        console.log(`Error occured during itemized entry update: ${error}`);
        response.sendStatus(500);
      }
    });
  }
);

async function emailReport(user_email: string, file_path:string) {
  const support_send_email = "noreply@zerobaseapp.com";
  const mailOptions = {
    //from: "ZeroBase Support <noreply@zerobaseapp.com>",
    from: support_send_email,
    to: user_email,
    subject: "ZeroBase Excel Report", // email subject
    html: `Hello,<br><br>Attached please find the report you requested<br><br>
    Your ZeroBase Support team`, // email content in HTML
    attachments: [
      {   // file on disk as an attachment
        filename: 'report.csv',
        path: file_path // stream this file
    }]
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
      console.log(
        `Error occured sending mail: ${JSON.stringify(error)}`
      );
      // return res.send(`Unknown error. Please contact support`);
    } else {
      // return res.send(
      //   `Request submitted. Link will be sent if a user with email address ${user_email} exists.`
      // );
    }
  });
}


