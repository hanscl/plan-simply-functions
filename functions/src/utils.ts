import * as entity_model from "./entity_model";
import * as admin from "firebase-admin";

const db = admin.firestore();

export enum ReplacePosition {
  start = 0,
  end = -1,
}

export function extractAcctFromFullAccount(
  full_acct: string,
  format_coll: string[],
  param: string
) {
  const search_str = `@${param}@`;

  let placeholder = "";
  const full_acct_groups = full_acct.split(".").length;
  for (const plc_hld of format_coll) {
    if (plc_hld.split(".").length === full_acct_groups) {
      placeholder = plc_hld;
      break;
    }
  }

  if (placeholder === "")
    throw new Error(
      "[UTILS - extractAcctFromFullAccount] No matching account string found"
    );
  
  console.log(`placeholder string: ${placeholder}`);

  // find param in placeholder
  console.log(`searching for ${search_str} in ${placeholder}`);
  const acct_begin_idx = placeholder.indexOf(search_str);
  if (acct_begin_idx === -1) {
    return undefined;
  }
  const string_before_acct = placeholder.substring(0, acct_begin_idx);
  console.log(`string_before_acct = ${string_before_acct}`);

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
  console.log(`dot_begin_pos now: ${dot_begin_pos}`);
  if (dot_begin_pos === -1) return undefined;

  let dot_end_pos = full_acct.indexOf(".", dot_begin_pos + 1);
  dot_end_pos = dot_end_pos === -1 ? full_acct.length : dot_end_pos;
  

  // finally extract the string
  const acct = full_acct.substring(dot_begin_pos + 1, dot_end_pos);

  return acct;
}

export function buildFullAccountString(
  format_str: string[],
  components: entity_model.acctComponents
) {
  const cmp_cnt = components.dept === undefined ? 3 : 4;

  // find the correct placeholder string
  let placeholder = "";
  for (const pclhld of format_str) {
    if (pclhld.split(".").length === cmp_cnt) {
      placeholder = pclhld;
      break;
    }
  }

  let ret_str = placeholder
    .replace("@acct@", components.acct)
    .replace("@div@", components.div);
  if (components.dept !== undefined) {
    ret_str = ret_str.replace("@dept@", components.dept);
  } else {
    ret_str = ret_str.replace(".@dept@", "");
  }

  return ret_str;
}

export function buildFixedAccountString(format_str:string, components:{div?: string, dept?: string, acct?: string} ) {
  let full_account = format_str;
  if(components.div !== undefined) full_account = full_account.replace("@div@", components.div);
  if(components.dept !== undefined) full_account = full_account.replace("@dept@", components.dept);
  if(components.acct !== undefined) full_account = full_account.replace("@acct@", components.acct);

  return full_account;
}

export function extractComponentsFromFullAccountString(
  full_account: string,
  format_coll: string[]
): entity_model.acctComponents {
  const div = extractAcctFromFullAccount(full_account, format_coll, "div");
  const acct = extractAcctFromFullAccount(full_account, format_coll, "acct");
  const dept = extractAcctFromFullAccount(full_account, format_coll, "dept");

  return {
    div: div === undefined ? "" : div,
    dept: dept,
    acct: acct === undefined ? "" : acct,
  };
}

export function substituteEntityForRollup(
  origText: string,
  embed_maps: entity_model.entityEmbed[] | undefined,
  entityId: string
): string {
  if(embed_maps === undefined) return origText;

  const fltrd_dept_embeds = embed_maps.filter((embed_map) => {
    return embed_map.field === "dept";
  });

  if (fltrd_dept_embeds.length < 1) return origText;


  if (fltrd_dept_embeds[0].pos === ReplacePosition.end) {
    return `${origText.substring(
      0,
      origText.length - entityId.length
    )}${entityId}`;
  } else if (fltrd_dept_embeds[0].pos === ReplacePosition.start) {
    return `${entityId}${origText.substring(entityId.length)}`;
  }

  return "";
}

export async function deleteCollection(
  collectionRef: FirebaseFirestore.CollectionReference<
    FirebaseFirestore.DocumentData
  >,
  batchSize: number
) {
  const query = collectionRef.orderBy("__name__").limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(query, resolve).catch(reject);
  });
}

async function deleteQueryBatch(
  query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData>,
  resolve: any
) {
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
