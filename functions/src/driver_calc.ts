import * as admin from "firebase-admin";
import * as driver_model from "./driver_model";
import * as plan_model from "./plan_model";
import * as utils from "./utils";

const db = admin.firestore();

export async function driverCalcValue(driver_def: driver_model.acctDriverDef, driver_params: driver_model.driverParamsAll) {
  try {
    await db.runTransaction(async (driver_tx) => {
      // (1) Resolve the first driver to a numbers array (call get AccoutnValuye)
      console.log(`before loop: ${JSON.stringify(driver_def)}`);
      let last_result: number[] = await getAccountValue(driver_tx, driver_def.drivers[0], driver_params);

      for (let idx = 0; idx < driver_def.operations.length; idx++) {
        console.log(`inside loop with index ${idx}: ${JSON.stringify(driver_def)}`);
        last_result = await processDriverCombination(driver_tx, driver_params, last_result, driver_def.operations[idx], driver_def.drivers[idx + 1]);
      }

      // get the document reference and update using transaction
      const acct_doc_ref = db.doc(
        `entities/${driver_params.entity_id}/plans/${driver_params.plan_id}/versions/${driver_params.version_id}/dept/${driver_params.acct_id}`
      );
      driver_tx.update(acct_doc_ref, { values: last_result, calc_type: "driver" });
    });
  } catch (e) {
    console.log("Transaction failure:", e);
  }
}

async function processDriverCombination(
  driver_tx: FirebaseFirestore.Transaction,
  driver_params: driver_model.driverParamsAll,
  first_operand: number[],
  operation: "add" | "sub" | "mlt" | "dvs" | "pct",
  next_driver: driver_model.driverEntry
) {
  let second_operand: number[] = [];
  if (next_driver.type === "acct") second_operand = await getAccountValue(driver_tx, next_driver, driver_params);
  else second_operand = next_driver.entry as number[];

  const driver_result: number[] = utils.getValuesArray();

  for (let idx = 0; idx < first_operand.length; idx++) {
    driver_result[idx] = utils.finRound(performDriverCalc([first_operand[idx], second_operand[idx]], operation));
  }

  return driver_result;
}

async function getAccountValue(
  driver_tx: FirebaseFirestore.Transaction,
  driver_entry: driver_model.driverEntry,
  driver_params: driver_model.driverParamsAll
) {
  // make sure this is a driver account
  if (!(driver_entry.type === "acct")) {
    console.log("cannot get account value for value-based driver");
    return [];
  }
  // get the driver acct
  const driver_account = driver_entry.entry as driver_model.driverAcct;

  // query the accounts
  const version_str = `entities/${driver_params.entity_id}/plans/${driver_params.plan_id}/versions/${driver_params.version_id}`;
  const acct_ref = db.doc(`${version_str}/${driver_account.level}/${driver_account.id}`);
  const acct_doc = await driver_tx.get(acct_ref);

  // confirm we received a doc
  if (!acct_doc.exists)
    throw new Error(`Could not find account ${driver_account.id} in collection ${driver_account.level} for version ${driver_params.version_id}`);

  // and return the values array
  return (acct_doc.data() as plan_model.accountDoc).values;
}

function performDriverCalc(operands: number[], operator: string): number {
  // make sure we got two operands
  if (!(operands.length === 2)) return 0;

  // perform calculation and return value
  if (operator === "add") return operands[0] + operands[1];
  else if (operator === "dvs") {
    if (operands[0] === 0) return 0;
    else return operands[0] / operands[1];
  } else if (operator === "mlt") return operands[0] * operands[1];
  else if (operator === "sub") return operands[0] - operands[1];
  else if (operator === "pct") return operands[0] * (operands[1] / 100);

  // if no valid operation, return failure value
  return -99.99;
}
