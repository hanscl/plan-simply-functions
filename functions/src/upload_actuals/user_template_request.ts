import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as httpsUtils from '../https_utils';
import * as config from '../config';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { createUploadTemplate } from './create_upload_template';

import { UploadTemplateRequest } from './upload_model';
import { saveUploadTemplateToStorage } from './save_upload_template'

const cors = require('cors')({ origin: true });

const db = admin.firestore();

export const requestUploadTemplate = functions
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

        const authToken = httpsUtils.validateHeader(request); // current user encrypted

        if (!authToken) {
          response.status(403).send('Unauthorized! Missing auth token!');
          return;
        }

        const dec_token = await httpsUtils.decodeAuthToken(authToken);

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

        const templateRequest = request.body as UploadTemplateRequest;

        const file_name = `upload_template_${templateRequest.entityId}_${templateRequest.versionId}.csv`;
        const temp_file_path = path.join(os.tmpdir(), file_name);

        await createUploadTemplate(temp_file_path, templateRequest);
        await saveUploadTemplateToStorage(temp_file_path, file_name, dec_token, templateRequest);

        fs.unlinkSync(temp_file_path);

        response.status(200).send({ result: `Template has been created.` });
      } catch (error) {
        console.log(`Error occured whil generating excel report: ${error}`);
        response.status(500).send({ result: `Error creating template. Please contact support` });
      }
    });
  });
