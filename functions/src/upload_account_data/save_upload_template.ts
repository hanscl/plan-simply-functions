//import * as fs from 'fs-extra';
import * as admin from 'firebase-admin';
import { getProjectId } from '../config';
import {UINotificationMessage} from '../message_model';
import {UploadTemplateRequest} from './upload_model';

const db = admin.firestore();

export const saveUploadTemplateToStorage = async (path: string, fileName: string, uid:string, templateRequest: UploadTemplateRequest)  => {
  try {
    const bucketName = `${getProjectId()}.appspot.com`;
    const bucketFile = `upload-templates/${fileName}`;
    console.log(`Bucket: ${bucketName}`);
    const bucket = admin.storage().bucket(bucketName);
    await bucket.upload(path, { destination: bucketFile })
    const expiresInMilliseconds =  new Date().getTime() + (24 * 60 * 60 * 1000);

    bucket.file(bucketFile).getSignedUrl({action:'read', expires: expiresInMilliseconds}, async (err, url) => {
        if(err) {
            throw new Error(`Error trying to get a URL for the upload template: ${err}`);
        }
        console.log(url);
        // save new message to DB
        const uiNotification: UINotificationMessage = {
            is_new: true,
            message:`Your requested upload template for ${templateRequest.entityId} is ready for download.`,
            subject:`New Template Ready`,
            received_at: admin.firestore.Timestamp.now(),
            link: {display_text: `${templateRequest.entityId} Upload Template`, url: url ? url:''}
        }

        try {

        await db.collection(`messages/ui_notifications/${uid}`).add(uiNotification);
        }
        catch(error) {
            console.log(`ERROR: ${error}`);
        }
    })

  } catch (error) {
    throw new Error(`Error occured in saveUploadTemplateToStorage: ${error}`);
  }
};

