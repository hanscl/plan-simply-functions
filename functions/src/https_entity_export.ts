import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as https_utils from './utils/https_utils';
import * as export_model from './export_model';
import * as config from './config';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import * as user_model from './user_model';
import * as nodemailer from 'nodemailer';
import * as export_accounts from './export_accounts_csv';
import * as export_planlabor from './export_planlabor_xls';

const cors = require('cors')({ origin: true });
const key = require('../alert-condition-291223-fe5b366c5ed9.json');

const db = admin.firestore();

export const entityExportRequest = functions
  .runWith({ timeoutSeconds: 180 })
  .region(config.cloudFuncLoc)
  .https.onRequest(async (request, response) => {
    cors(request, response, async () => {
      try {
        response.set('Access-Control-Allow-Origin', '*');
        response.set('Access-Control-Allow-Credentials', 'true');

        if (request.method === 'OPTIONS') {
          response.set('Access-Control-Allow-Methods', 'GET');
          response.set('Access-Control-Allow-Headers', 'Authorization');
          response.set('Access-Control-Max-Age', '3600');
          response.status(204).send('');

          return;
        }

        const authToken = https_utils.validateHeader(request); // current user encrypted

        if (!authToken) {
          response.status(403).send('Unauthorized! Missing auth token!');
          return;
        }

        const dec_token = await https_utils.decodeAuthToken(authToken);

        if (dec_token === undefined) {
          response.status(403).send('Invalid token.');
          return;
        }

        console.log(`uid: ${dec_token}`);

        const user_snap = await db.doc(`users/${dec_token}`).get();
        if (!user_snap.exists) {
          response.status(403).send('User not known in this system!');
          return;
        }

        const report_request = request.body as export_model.reportRequest;

        let file_name = undefined;
        let temp_file_path = undefined;
        let subject = undefined;
        if (report_request.output === 'csv') {
          file_name = `${report_request.entity_id}_Accounts_${report_request.version_id}.csv`;
          temp_file_path = path.join(os.tmpdir(), file_name);
          await export_accounts.exportAccountsToCsv(temp_file_path, report_request);
          subject = `${report_request.entity_id} Accounts CSV Report`;
        } else if (report_request.output === 'xls') {
          file_name = `${report_request.entity_id}_Pnl-Labor_${report_request.version_id}.xlsx`;
          temp_file_path = path.join(os.tmpdir(), file_name);
          await export_planlabor.exportPlanLaborToXls(temp_file_path, report_request);
          subject = `${report_request.entity_id} P&L/Labor Excel Report`;
        } else {
          console.log(`Invalid report request format: ${report_request.output}`);
          return;
        }

        //await fs.outputFile(temp_file_path, JSON.stringify(xls_request));

        // get user email
        const email = (user_snap.data() as user_model.userDoc).email;

        console.log(`Emailing ${JSON.stringify(report_request)} reports to ${email}`);
        await emailReport(email, temp_file_path, subject, file_name);

        fs.unlinkSync(temp_file_path);
        response.status(200).send({ result: `Report email dispatched.` });
      } catch (error) {
        console.log(`Error occured whil generating excel report: ${error}`);
        response.status(500).send({ result: `Error sending report. Please contact support` });
      }
    });
  });

async function emailReport(user_email: string, file_path: string, subject: string, filename: string) {
  const support_send_email = 'noreply@zerobaseapp.com';
  const mailOptions = {
    from: support_send_email,
    to: user_email,
    subject: subject, // email subject
    html: `Hello,<br><br>Attached please find the report you requested<br><br>
    Your ZeroBase Support team`, // email content in HTML
    attachments: [
      {
        // file on disk as an attachment
        filename: filename,
        path: file_path, // stream this file
      },
    ],
  };

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      type: 'OAuth2',
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
