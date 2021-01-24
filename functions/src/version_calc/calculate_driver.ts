import * as admin from 'firebase-admin';
import { CalcRequest } from './version_calc_model';
import { acctDriverDef, DriverEntry, driverAcct } from '../driver_model';
import { accountDoc } from '../plan_model';

import * as utils from '../utils/utils';

const db = admin.firestore();

export const calculateDriverAccount = async (calcRequest: CalcRequest, fullAccountId: string) => {
  const driverDefDocSnap = await db
    .doc(`entities/${calcRequest.entityId}/drivers/${calcRequest.versionId}/dept/${fullAccountId}`)
    .get();

  if (!driverDefDocSnap.exists) {
    throw new Error(`Could not find driver definition for ${fullAccountId}`);
  }

  const driverDefinition = driverDefDocSnap.data() as acctDriverDef;
  let last_result: number[] = await getAccountValue(driverDefinition.drivers[0], calcRequest);

  for (let idx = 0; idx < driverDefinition.operations.length; idx++) {
    last_result = await processDriverCombination(
      calcRequest,
      last_result,
      driverDefinition.operations[idx],
      driverDefinition.drivers[idx + 1]
    );
  }

  return last_result;
};

async function processDriverCombination(
  calcRequest: CalcRequest,
  firstOperand: number[],
  operation: 'add' | 'sub' | 'mlt' | 'dvs' | 'pct',
  nextDriver: DriverEntry
) {
  let secondOperand: number[] = [];

  if (nextDriver.type === 'acct') {
    secondOperand = await getAccountValue(nextDriver, calcRequest);
  } else secondOperand = nextDriver.entry as number[];

  const driverResult: number[] = utils.getValuesArray();

  for (let idx = 0; idx < firstOperand.length; idx++) {
    driverResult[idx] = utils.finRound(performDriverCalc([firstOperand[idx], secondOperand[idx]], operation));
  }

  return driverResult;
}

async function getAccountValue(driverEntry: DriverEntry, calcRequest: CalcRequest) {
  // make sure this is a driver account
  if (!(driverEntry.type === 'acct')) {
    console.log('cannot get account value for value-based driver');
    return [];
  }
  // get the driver acct
  const driverAccount = driverEntry.entry as driverAcct;

  // query the accounts
  const versionDocRef = `entities/${calcRequest.entityId}/plans/${calcRequest.planId}/versions/${calcRequest.versionId}`;
  const acctDocRef = db.doc(`${versionDocRef}/${driverAccount.level}/${driverAccount.id}`);
  const acctDoc = await acctDocRef.get();

  // confirm we received a doc
  if (!acctDoc.exists)
    throw new Error(
      `Could not find account ${driverAccount.id} in collection ${driverAccount.level} for version ${calcRequest.versionId}`
    );

  // and return the values array
  return (acctDoc.data() as accountDoc).values;
}

function performDriverCalc(operands: number[], operator: string): number {
  // make sure we got two operands
  if (!(operands.length === 2)) return 0;

  // perform calculation and return value
  if (operator === 'add') return operands[0] + operands[1];
  else if (operator === 'dvs') {
    if (operands[0] === 0) return 0;
    else return operands[0] / operands[1];
  } else if (operator === 'mlt') return operands[0] * operands[1];
  else if (operator === 'sub') return operands[0] - operands[1];
  else if (operator === 'pct') return operands[0] * (operands[1] / 100);

  // if no valid operation, return failure value
  return -99.99;
}
