import { CalcRequest, AccountCalculationType } from './version_calc_model';
import * as admin from 'firebase-admin';
import * as utils from '../utils';
import * as entityModel from '../entity_model';
import * as planModel from '../plan_model';

const db = admin.firestore();

export const calculateDivDeptRollup = async (
  calcRequest: CalcRequest,
  fullAccountId: string,
  accountType: AccountCalculationType,
  entity: entityModel.entityDoc
) => {
  const acctCmpnts = utils.extractComponentsFromFullAccountString(fullAccountId, [
    entity.full_account,
    entity.div_account,
  ]);

  const versionDocumentReference = db.doc(
    `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`
  );

  let query = versionDocumentReference.collection('dept').where('div', '==', acctCmpnts.div);

  if (accountType === 'dept') {
    query = query.where('dept', '==', acctCmpnts.dept).where('parent_rollup.acct', '==', acctCmpnts.acct);
  } else {
    query = query.where('acct', '==', acctCmpnts.acct).where('group', '==', false);
  }

  let monthValuesRollupTotal: number[] = utils.getValuesArray();
  const acctCollectionSnapshot = await query.get();
  for (const accountDocument of acctCollectionSnapshot.docs) {
    const account = accountDocument.data() as planModel.accountDoc;
    monthValuesRollupTotal = utils.addValuesByMonth(
      monthValuesRollupTotal,
      account.values.map((val) => (val * (account.parent_rollup && accountType === 'dept' ? account.parent_rollup.operation : 1)))
   );
  }
  return monthValuesRollupTotal;
};
