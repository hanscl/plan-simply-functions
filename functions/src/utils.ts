import * as entity_model from "./entity_model";

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

  // find param in placeholder
  const acct_begin_idx = placeholder.indexOf(search_str);
  if (acct_begin_idx === -1) {
    return undefined;
  }
  const string_before_acct = placeholder.substring(0, acct_begin_idx);

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
  pos: ReplacePosition,
  entityId: string
): string {
  if (pos === ReplacePosition.end) {
    return `${origText.substring(
      0,
      origText.length - entityId.length
    )}${entityId}`;
  } else if (pos === ReplacePosition.start) {
    return `${entityId}${origText.substring(entityId.length)}`;
  }

  return "";
}
