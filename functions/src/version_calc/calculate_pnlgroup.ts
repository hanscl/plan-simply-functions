import { CalcRequest, AccountCalculationType, mapTypeToLevel } from './version_calc_model';
import * as admin from 'firebase-admin';
import * as utils from '../utils';
import * as planModel from '../plan_model';
import * as viewModel from '../view_model';

const db = admin.firestore();

export const calculatePnlOrGroupRollup = async (
  calcRequest: CalcRequest,
  fullAccountId: string,
  accountType: AccountCalculationType
) => {
  const versionDocumentReference = db.doc(
    `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`
  );

  const pnlOrGroupRollupAcctDocSnap = await versionDocumentReference
    .collection(mapTypeToLevel[accountType])
    .doc(fullAccountId)
    .get();

  if (!pnlOrGroupRollupAcctDocSnap.exists) {
    throw new Error('pnl/group Rollup doc does not exist. Should not happen!');
  }

  let childAccts: string[] = [];
  let childAcctOps: number[] = [];
  let childAcctCollection = '';
  if (accountType === 'pnl') {
    childAccts = (pnlOrGroupRollupAcctDocSnap.data() as viewModel.pnlAggregateDoc).child_accts;
    childAcctOps =  (pnlOrGroupRollupAcctDocSnap.data() as viewModel.pnlAggregateDoc).child_ops;
    childAcctCollection = 'div';
  } else {
    // === 'group'
    childAcctCollection = 'dept';
    const group_children = (pnlOrGroupRollupAcctDocSnap.data() as planModel.accountDoc).group_children;
    if (group_children) childAccts = group_children;
  }

  const childAcctQuery = versionDocumentReference
    .collection(childAcctCollection)
    .where('full_account', 'in', childAccts);
  const acctCollectionSnapshot = await childAcctQuery.get();

  let monthValuesRollupTotal: number[] = utils.getValuesArray();
  for (const accountDocument of acctCollectionSnapshot.docs) {
    const account = accountDocument.data() as planModel.accountDoc;

    monthValuesRollupTotal = utils.addValuesByMonth(
      monthValuesRollupTotal,
      account.values.map(val => {
        if(accountType === 'group') {
          return val * 1;
        } else {
          return val * childAcctOps[childAccts.indexOf(account.full_account)];
        }
      })
     );
  }
  return monthValuesRollupTotal;
};
