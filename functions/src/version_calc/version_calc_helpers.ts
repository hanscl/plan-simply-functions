import * as entityModel from '../entity_model';
import * as planModel from '../plan_model';

import {CalcRequest} from './version_calc_model';

export const getEntityDetails = async (db: FirebaseFirestore.Firestore, entityId: string): Promise<entityModel.entityDoc> => {
    const entityDocument = await db.doc(`entities/${entityId}`).get();
    if (!entityDocument.exists) {
      throw new Error(`Entity Doc not found at getEntityDetails => This should never happen`);
    }
    return entityDocument.data() as entityModel.entityDoc;
  };
  
  export const getVersionDetails = async (db: FirebaseFirestore.Firestore, calcRequest: CalcRequest): Promise<planModel.versionDoc> => {
    const versionDocument = await db
      .doc(`entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`)
      .get();
    if (!versionDocument.exists) {
      throw new Error(`Version Doc not found at getVersionDetails => This should never happen`);
    }
    return versionDocument.data() as planModel.versionDoc;
  };