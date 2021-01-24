import * as admin from 'firebase-admin';
import * as fs from 'fs-extra';
import * as json2csv from 'json2csv';
import { UploadTemplateRequest, UploadTemplateCsv } from './upload_model';
import { entityDoc } from '../entity_model';
import { accountDoc } from '../plan_model';
import * as utils from '../utils/utils';

const db = admin.firestore();

export async function createUploadTemplate(path: string, templateParams: UploadTemplateRequest) {
  try {
    const data = await buildReportJson(templateParams);

    if (data === undefined) throw new Error(`BuildJsonDidNotReportData`);
    console.log(`back from buildJson`);
    console.log(`json data: ${JSON.stringify(data)}`);

    const csv_data = json2csv.parse(data);
    console.log(`csv data: ${JSON.stringify(csv_data)}`);

    await fs.outputFile(path, csv_data);
    return;
  } catch (error) {
    console.log(`Error occured while creating CSV upload template: ${error}`);
  }
}

async function buildReportJson(templateParams: UploadTemplateRequest): Promise<UploadTemplateCsv[] | undefined> {
  try {
    console.log(`Starting buildReportJson`);
    console.log(`report params ${templateParams}`);
    // load the entity doc
    const entity_snap = await db.doc(`entities/${templateParams.entityId}`).get();
    if (!entity_snap.exists)
      throw new Error(
        `buildReportJson >> No entity doc found for entity ${templateParams.entityId}. Aborting function`
      );

    const entity = entity_snap.data() as entityDoc;

    const temmplateObject: UploadTemplateCsv[] = [];

    // load all accounts from this version
    const acctVersionSnap = await entity_snap.ref
      .collection(`plans/${templateParams.planId}/versions/${templateParams.versionId}/dept`)
      .where('class', '==', 'acct')
      .get();

    for (const acctDoc of acctVersionSnap.docs) {
      const account = acctDoc.data() as accountDoc;
      const fullAccount = utils.buildFullAccountString([entity.full_account], {
        dept: account.dept,
        acct: account.acct,
        div: account.div,
      });

      // Create the basic CSV_line
      const csvLine: UploadTemplateCsv = {
        company: entity.number,
        cost_center: account.dept ? account.dept : '',
        full_account: fullAccount,
        gl_acct: account.acct,
        gl_name: account.acct_name,
      };

      csvLine.period_01 = 0;
      csvLine.period_02 = 0;
      csvLine.period_03 = 0;
      csvLine.period_04 = 0;
      csvLine.period_05 = 0;
      csvLine.period_06 = 0;
      csvLine.period_07 = 0;
      csvLine.period_08 = 0;
      csvLine.period_09 = 0;
      csvLine.period_10 = 0;
      csvLine.period_11 = 0;
      csvLine.period_12 = 0;

      temmplateObject.push(csvLine);
    }

    console.log(`report obj before return: ${JSON.stringify(temmplateObject)}`);

    return temmplateObject;
  } catch (error) {
    console.log(`Error in buildJsonReport: ${error}`);
    return undefined;
  }
}
