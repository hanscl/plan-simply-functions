import { CalcRequest, AccountCalculationType, mapTypeToLevel } from './version_calc_model';
import { calculateDriverAccount } from './calculate_driver';
import { calculateDivDeptRollup } from './calculate_divdept';
import { calculatePnlOrGroupRollup } from './calculate_pnlgroup';
import * as utils from '../utils/utils';
import * as entityModel from '../entity_model';
import * as admin from 'firebase-admin';
import { accountDoc } from '../plan_model';

const db = admin.firestore();

export const calculateAccount = async (
  calcRequest: CalcRequest,
  fullAccountId: string,
  acctType: AccountCalculationType,
  entity: entityModel.entityDoc
) => {
  if (fullAccountId.indexOf('STATS') > 0) {
    return;
  }

  let monthValuesForAccount: number[] = [];
  if (acctType === 'driver') {
    monthValuesForAccount = await calculateDriverAccount(calcRequest, fullAccountId);
  } else if (acctType === 'div' || acctType === 'dept') {
    monthValuesForAccount = await calculateDivDeptRollup(calcRequest, fullAccountId, acctType, entity);
  } else if (acctType === 'pnl' || acctType === 'group') {
    monthValuesForAccount = await calculatePnlOrGroupRollup(calcRequest, fullAccountId, acctType);
  }

  const annualTotal = utils.finRound(monthValuesForAccount.reduce((a, b) => a + b, 0));
  // console.log(
  //   `Annual Total for account ${fullAccountId} of type ${acctType} is ${annualTotal}. MONTHLY: ${monthValuesForAccount}`
  // );

  // save account
  const versionDocRef = db.doc(
    `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`
  );
  await versionDocRef
    .collection(mapTypeToLevel[acctType])
    .doc(fullAccountId)
    .update({ total: annualTotal, values: monthValuesForAccount });
};

// export const getChildAccountValue = async (
//   calcRequest: CalcRequest,
//   childAccountId: string,
//   acctCollRef: FirebaseFirestore.CollectionReference
// ): Promise<number[]> => {
//   const childAcctDocSnap = await acctCollRef.doc(childAccountId).get();
//   if (!childAcctDocSnap.exists) {
//     throw new Error('Child Account does not exist. Fatal!');
//   }
//   const account = childAcctDocSnap.data() as planModel.accountDoc;
//   return account.values;
// };

export const recalcAnnualTotalsForItemizedEntry = async (versionDocRef: FirebaseFirestore.DocumentReference) => {
  let batch = db.batch();
  let txCtr = 0;

  const nLevelAccts = await versionDocRef.collection('dept').where('class', '==', 'acct').get();

  for (const acctDocument of nLevelAccts.docs) {
    const account = acctDocument.data() as accountDoc;

    if (!account.calc_type || account.calc_type === 'entry') {
      let acctValsTotal = account.values.reduce((a, b) => a + b, 0);
      if (account.avg_as_total) {
        acctValsTotal = acctValsTotal / account.values.length;
      } 
      batch.update(acctDocument.ref, 'total', utils.finRound(acctValsTotal));
      txCtr++;
    }

    if (txCtr > 400) {
      await batch.commit();
      batch = db.batch();
      txCtr = 0;
    }
  }

  if (txCtr > 0) {
    await batch.commit();
  }
};
