import * as entity_model from "./entity_model";
import * as admin from "firebase-admin";

const db = admin.firestore();

export enum ReplacePosition {
  start = 0,
  end = -1,
}

export function extractAcctFromFullAccount(full_acct: string, format_coll: string[], param: string) {
  const search_str = `@${param}@`;

  let placeholder = "";
  const full_acct_groups = full_acct.split(".").length;
  for (const plc_hld of format_coll) {
    if (plc_hld.split(".").length === full_acct_groups) {
      placeholder = plc_hld;
      break;
    }
  }

  if (placeholder === "") throw new Error("[UTILS - extractAcctFromFullAccount] No matching account string found");

  //console.log(`placeholder string: ${placeholder}`);

  // find param in placeholder
  //console.log(`searching for ${search_str} in ${placeholder}`);
  const acct_begin_idx = placeholder.indexOf(search_str);
  if (acct_begin_idx === -1) {
    return undefined;
  }
  const string_before_acct = placeholder.substring(0, acct_begin_idx);
  //console.log(`string_before_acct = ${string_before_acct}`);

  // count the dots
  let dot_ctr = -1;
  let dot_index = 0;
  while (dot_index > -1) {
    dot_ctr++;
    dot_index = string_before_acct.indexOf(".", dot_index + 1);
  }

  // now find the correct position in the full account string
  let dot_begin_pos = -1;
  for (let idx = 0; idx < dot_ctr; idx++) {
    dot_begin_pos = full_acct.indexOf(".", dot_begin_pos + 1);
  }
  //console.log(`dot_begin_pos now: ${dot_begin_pos}`);
  if (dot_begin_pos === -1) return undefined;

  let dot_end_pos = full_acct.indexOf(".", dot_begin_pos + 1);
  dot_end_pos = dot_end_pos === -1 ? full_acct.length : dot_end_pos;

  // finally extract the string
  const acct = full_acct.substring(dot_begin_pos + 1, dot_end_pos);

  return acct;
}

export function buildFullAccountString(format_str: string[], components: entity_model.acctComponents) {
  const cmp_cnt = components.dept === undefined ? 3 : 4;

  // find the correct placeholder string
  let placeholder = "";
  for (const pclhld of format_str) {
    if (pclhld.split(".").length === cmp_cnt) {
      placeholder = pclhld;
      break;
    }
  }

  let ret_str = placeholder.replace("@acct@", components.acct).replace("@div@", components.div);
  if (components.dept !== undefined) {
    ret_str = ret_str.replace("@dept@", components.dept);
  } else {
    ret_str = ret_str.replace(".@dept@", "");
  }

  return ret_str;
}

export function buildFixedAccountString(format_str: string, components: { div?: string; dept?: string; acct?: string }) {
  let full_account = format_str;
  if (components.div !== undefined) full_account = full_account.replace("@div@", components.div);
  if (components.dept !== undefined) full_account = full_account.replace("@dept@", components.dept);
  if (components.acct !== undefined) full_account = full_account.replace("@acct@", components.acct);

  return full_account;
}

export function extractComponentsFromFullAccountString(full_account: string, format_coll: string[]): entity_model.acctComponents {
  const div = extractAcctFromFullAccount(full_account, format_coll, "div");
  const acct = extractAcctFromFullAccount(full_account, format_coll, "acct");
  const dept = extractAcctFromFullAccount(full_account, format_coll, "dept");

  return {
    div: div === undefined ? "" : div,
    dept: dept,
    acct: acct === undefined ? "" : acct,
  };
}

export function substituteEntityForRollup(origText: string, embed_maps: entity_model.entityEmbed[] | undefined, entityId: string): string {
  if (embed_maps === undefined) return origText;

  const fltrd_dept_embeds = embed_maps.filter((embed_map) => {
    return embed_map.field === "dept";
  });

  if (fltrd_dept_embeds.length < 1) return origText;

  if (fltrd_dept_embeds[0].pos === ReplacePosition.end) {
    return `${origText.substring(0, origText.length - entityId.length)}${entityId}`;
  } else if (fltrd_dept_embeds[0].pos === ReplacePosition.start) {
    return `${entityId}${origText.substring(entityId.length)}`;
  }

  return "";
}

export async function deleteDocumentsByQuery(documentQuery: FirebaseFirestore.Query, batchSize: number) {
  const query = documentQuery.limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(query, resolve).catch(reject);
  });
}


export async function deleteCollection(collectionRef: FirebaseFirestore.CollectionReference<FirebaseFirestore.DocumentData>, batchSize: number) {
  const query = collectionRef.orderBy("__name__").limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(query, resolve).catch(reject);
  });
}

async function deleteQueryBatch(query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>, resolve: any) {
  const snapshot = await query.get();

  const batchSize = snapshot.size;
  if (batchSize === 0) {
    // When there are no documents left, we are done
    resolve();
    return;
  }

  // Delete documents in a batch
  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();

  // Recurse on the next process tick, to avoid
  // exploding the stack.
  process.nextTick(() => {
    deleteQueryBatch(query, resolve).catch();
  });
}

export function getDaysInMonth(begin_year: number, begin_month: number): number[] {
  // initialize arrays
  const daysInMonth = [];

  let curr_month = begin_month;
  let curr_year = begin_year;

  for (let ctr = 0; ctr < 12; ctr++) {
    if (curr_month === 13) {
      curr_month = 1;
      curr_year++;
    }
    // calculate the days in the month and push into array
    if ([1, 3, 5, 7, 8, 10, 12].includes(curr_month)) daysInMonth.push(31);
    else if ([4, 6, 9, 11].includes(curr_month)) daysInMonth.push(30);
    else {
      if (leapyear(curr_year)) daysInMonth.push(29);
      else daysInMonth.push(28);
    }
    curr_month++;
  }
  return daysInMonth;
}

function leapyear(year: number) {
  return year % 100 === 0 ? year % 400 === 0 : year % 4 === 0;
}

export function getValuesArray(): number[] {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
}

export function finRound(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function areValuesIdentical(vals1: number[], vals2: number[]): boolean {
  if (vals1.length !== vals2.length) return false;

  for (let idx = 0; idx < vals1.length; idx++) {
    if (finRound(vals1[idx]) !== finRound(vals2[idx])) return false;
  }

  return true;
}

export function getTotalValues(values: number[]): number {
  return finRound(
    values.reduce((a, b) => {
      return a + b;
    }, 0)
  );
}

export function addValuesByMonth(vals1: number[], vals2: number[]): number[] {
  const ret_array = getValuesArray();
  if (vals1.length !== vals2.length) return ret_array;
  for (let i = 0; i < vals1.length; i++) {
    ret_array[i] = vals1[i] + vals2[i];
  }
  return ret_array;
}

export function getValueDiffsByMonth(vals_before: number[], vals_after: number[], diff_by_month: number[], months_changed: number[]): number | undefined {
  // makes sure the arrays have the same length
  if (vals_after.length !== vals_before.length) return undefined;

  // initialize variables for tracking changes in monthly data
  let diff_total = 0;

  // calculate difference for each month and track which months changed
  for (let periodIdx = 0; periodIdx < vals_before.length; periodIdx++) {
    diff_by_month[periodIdx] = finRound(vals_after[periodIdx]) - finRound(vals_before[periodIdx]);
    if (diff_by_month[periodIdx] !== 0) {
      months_changed.push(periodIdx);
      diff_total += diff_by_month[periodIdx];
    }
  }

  return diff_total;
}

export function valuesNullConversion(values: number[]) {
  let found_null = false;
  console.log(`utils called for valuesNullConversion with ${JSON.stringify(values)}`);
  for (let i = 0; i < values.length; i++) {
    if ((!values[i] && values[i] !== 0) || values[i] === undefined || values[i] === null) {
      values[i] = 0;
      found_null = true;
    }
  }

  console.log(`clean array before return: ${JSON.stringify(values)}`);
  return found_null;
}

export function arraySubtract(minuend: number[], subtrahend: number[]): number[] {
  if (minuend.length !== subtrahend.length) throw new Error("Subtracting arrays must have same length");

  const difference: number[] = [];

  for (let idx = 0; idx < minuend.length; idx++) {
    difference.push(minuend[idx] - subtrahend[idx]);
  }

  return difference;
}

export const initializeVersionLockObject = (lockStatus: boolean) => {
  const lockObj = {all: lockStatus, periods: [] as boolean[]}
  
  for(let i = 0; i< 12; i++) {
    lockObj.periods.push(lockStatus);
  }

  return lockObj;
}