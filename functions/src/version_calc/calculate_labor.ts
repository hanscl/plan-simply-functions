import * as admin from 'firebase-admin';

import { CalcRequest, AccountTotal } from './version_calc_model';

import * as entityModel from '../entity_model';
import * as planModel from '../plan_model';
import * as laborModel from '../labor/labor_model';
import * as utils from '../utils/utils';
import * as laborCalc from '../labor/labor_calc';
import {getBeginYearAndMonth} from '../utils/version_calendar';

interface AccountComponents {
  acctId: string;
  deptId: string;
  divId: string;
}

const db = admin.firestore();

export const sumUpLaborTotalsFromPositions = async (
  calcRequest: CalcRequest,
  entity: entityModel.entityDoc,
  version: planModel.versionDoc
) => {
  try {
        // loop through all positions, add wages (and bonus/socialSec for v2) and set account to laborCalc
    const positionCollectionSnapshot = await db
      .collection(`entities/${calcRequest.entityId}/labor/${calcRequest.versionId}/positions`)
      .get();
    const laborAccountTotals: AccountTotal[] = [];
    console.log(`entities/${calcRequest.entityId}/labor/${calcRequest.versionId}/positions`);
    console.log(JSON.stringify(positionCollectionSnapshot));
    for (const positionDocument of positionCollectionSnapshot.docs) {
      const position = positionDocument.data() as laborModel.PositionDoc;
      // refresh the position
      await recalculateLaborPosition(positionDocument.ref, position, calcRequest, entity);

      const acctDivDept = { deptId: position.dept, divId: position.div };
      addAccountValue({ ...acctDivDept, acctId: position.acct }, laborAccountTotals, position.wages.values, entity);

      // OPTIONAL FOR LABOR MODEL V2
      if (version.labor_version && version.labor_version > 1) {
        const acctSocialCmpnts = { ...acctDivDept, acctId: entity.labor_settings.default_accts.socialsec };
        addAccountValue(acctSocialCmpnts, laborAccountTotals, position.socialsec.values, entity);

        const acctBonusCmpnts = { ...acctDivDept, acctId: entity.labor_settings.default_accts.bonus };
        if (position.bonus_option !== 'None') {
          addAccountValue(acctBonusCmpnts, laborAccountTotals, position.bonus.values, entity);
        }
      }
    }

    await updateLaborAccountsInFirestore(calcRequest, laborAccountTotals);
  } catch (error) {
    console.log(`Error occured in [sumUpLaborTotalsFromPositions]: ${error}`);
  }
};

const addAccountValue = (
  acctCmpnts: AccountComponents,
  accountList: AccountTotal[],
  valuesToAdd: number[],
  entity: entityModel.entityDoc
) => {
  const fullAccountString = utils.buildFullAccountString([entity.full_account], {
    dept: acctCmpnts.deptId,
    div: acctCmpnts.divId,
    acct: acctCmpnts.acctId,
  });
  // see if account is already in array and add values if found; otherwise add new
  const filteredAccounts = accountList.filter((acct) => acct.acctId === fullAccountString);
  if (filteredAccounts.length > 0) {
    filteredAccounts[0].values = utils.addValuesByMonth(filteredAccounts[0].values, valuesToAdd);
  } else {
    accountList.push({ acctId: fullAccountString, values: valuesToAdd, total: 0 });
  }
};


const updateLaborAccountsInFirestore = async (calcRequest: CalcRequest, laborAccountTotals: AccountTotal[]) => {
    try {
      console.log('UPDATING LABOR ACCOUNTS:', JSON.stringify(laborAccountTotals));
      const firestoreBatch = db.batch();
      let batchCounter = 0;
      // firstly, calculate Totals
      laborAccountTotals.map((account) => {
        account.total = account.values.reduce((a, b) => a + b, 0);
      });
      for (const laborAccount of laborAccountTotals) {
        firestoreBatch.update(
          db.doc(
            `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}/dept/${laborAccount.acctId}`
          ),
          { total: laborAccount.total, values: laborAccount.values, calc_type: 'labor' }
        );
        batchCounter++;
      }
  
      if (batchCounter > 0) {
        // TODO: COMMENT IN FIRESTORE BATCH COMMIT
        firestoreBatch.commit();
      }
    } catch (error) {
      console.log(`Error occured in [updateLaborAccountsInFirestore]: ${error}`);
    }
  };

  const recalculateLaborPosition = async(positionDocRef: FirebaseFirestore.DocumentReference, position: laborModel.PositionDoc, calcRequest: CalcRequest, entity: entityModel.entityDoc) => {

    const {beginYear, beginMonth} = await getBeginYearAndMonth(calcRequest);

    // get the days in the month for this plan
    const daysInMonths = utils.getDaysInMonth(beginYear, beginMonth);

    const rateMap = laborCalc.calculateRate(position);

    // calculate wages
    let wages =null;
    if(entity.labor_settings.wage_method === 'us') {
      wages = laborCalc.calculateWagesUS(position,daysInMonths,position.ftes.values)
    } else {
      wages = laborCalc.calculateWagesEU(position, position.ftes.values);
    }
    if (!wages) throw new Error('Unable to calculate wages in [recalculateLaborPosition]');

    // calculate bonus
    const bonus = laborCalc.calculateBonus(position, wages.values);

    // calculate social security
    const socialsec = laborCalc.calculateSocialSec(position, wages.values);

    // calculate avg FTEs
    const ftes = laborCalc.calculateAvgFTEs(daysInMonths, position.ftes.values);

    position.rate = rateMap;
    position.wages = wages;
    position.bonus = bonus;
    position.socialsec = socialsec;
    position.ftes =  ftes;
    position.last_updated = admin.firestore.Timestamp.now();

    await positionDocRef.update(position);


  }