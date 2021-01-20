import * as admin from 'firebase-admin';

import { UploadAccountDataRequest } from './upload_model';

const db = admin.firestore();

export const validateUploadedData = async (uploadDataRequest: UploadAccountDataRequest) => {
    
    try {// check that accounts exist
    // return success or failure
    
    }
    catch(error) {
        throw new Error(`Error occured in [validateUploadedData]: ${error}`);
    }
}