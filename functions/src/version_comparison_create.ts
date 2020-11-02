//import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as compModel from "./version_comparison_model";
import * as planModel from "./plan_model";
import * as viewModel from "./view_model";
import * as utils from "./utils";

const db = admin.firestore();

interface CompAccts {
  compare: TempAcctItem[];
  base: TempAcctItem[];
}

interface TotalValues {
  total: number;
  values: number[];
}

interface TempAcctItem {
  id: string;
  name: string;
  acctValues: TotalValues;
}

interface WhereCond {
  field: string;
  cond: string;
}

export async function createVersionComparison(options: compModel.VersionCompWithUser) {
  try {
    console.log(`[createVersionComparison] called with options {${JSON.stringify(options)}}`);
    // create the document (or update in case this is a retry because the transaction failed)
    let compDocObj: compModel.VersionCompDocument | undefined = undefined;
    const dbEntityRef = db.doc(`entities/${options.entityId}`);
    const compDocId = `${options.baseVersion.versionId}_${options.compareVersion.versionId}`;
    const compDoc = await dbEntityRef.collection("comparisons").doc(compDocId).get();

    // if this document already exists, retain user ids
    if (compDoc.exists) {
      compDocObj = compDoc.data() as compModel.VersionCompDocument;
      // add user id from this request if it is not in the array yet
      if (!compDocObj.userIds.includes(options.userId)) compDocObj.userIds.push(options.userId);
    } else {
      compDocObj = {
        versionIds: [options.baseVersion.versionId, options.compareVersion.versionId],
        planIds: [options.baseVersion.planId, options.compareVersion.planId],
        userIds: [options.userId],
      }; // create a new document structure
    }

    console.log(`[createVersionComparison] compDocObj before save to firestore: ${JSON.stringify(compDocObj)}`);
    if (!compDocObj) throw new Error(`Unable to retrieve or create version comparison object`);

    // set document (create or update)
    await dbEntityRef.collection("comparisons").doc(compDocId).set(compDocObj);

    // begin transaction - lock the version document until we're done
    const txResult = await db.runTransaction(async (compTx) => {
      if (!compDocObj) return false;

      // lock both version docs
      const versionDocs = [];
      for (let idx = 0; idx < compDocObj.versionIds.length; idx++) {
        versionDocs.push(await compTx.get(db.doc(`entities/${options.entityId}/plans/${compDocObj.planIds[idx]}/versions/${compDocObj.versionIds[idx]}`)));
      }

      // store both plan-version refs
      const compareVersionRef = dbEntityRef
        .collection("plans")
        .doc(options.compareVersion.planId)
        .collection("versions")
        .doc(options.compareVersion.versionId);
      const baseVersionRef = dbEntityRef.collection("plans").doc(options.baseVersion.planId).collection("versions").doc(options.baseVersion.versionId);

      const compSections: compModel.CompSection[] = [];
      await pnlRollupCollection(options, compTx, compareVersionRef, baseVersionRef, compSections);
      for (const level of ["div", "dept"]) await divDeptCollection(options, compTx, compareVersionRef, baseVersionRef, compSections, level);

      // Let's see on the console what we got
      // console.log(`Account Comparison Objects: ${JSON.stringify(compSections)}`);

      for (const section of compSections) {
        compTx.set(dbEntityRef.collection("comparisons").doc(compDocId).collection(section.rollup.level).doc(section.rollup.id), section);
      }

      compTx.update(dbEntityRef.collection("comparisons").doc(compDocId), {
        last_updated: admin.firestore.Timestamp.now(),
        last_accessed: admin.firestore.Timestamp.now(),
        ready: true,
      });

      return "[createVersionComparison] completed successfully.";
    });
    console.log(txResult);
    return;
  } catch (error) {
    console.log(`Error ocurred in [createVersionComparison]: ${error}`);
    return Promise.reject();
  }
}

async function divDeptCollection(
  options: compModel.VersionCompWithUser,
  dbTx: FirebaseFirestore.Transaction,
  compareVersionRef: FirebaseFirestore.DocumentReference,
  baseVersionRef: FirebaseFirestore.DocumentReference,
  compSections: compModel.CompSection[],
  level: string
) {
  try {
    // get all rollups from the compare version
    const rollupAcctDocs = await dbTx.get(compareVersionRef.collection(level).where("class", "==", "rollup"));
    for (const divDeptRollupDoc of rollupAcctDocs.docs) {
      // get the pnl document data & create the minimal account object used across all levels
      const compareRollupAcct = divDeptRollupDoc.data() as planModel.accountDoc;
      const compareRollupTemp: TempAcctItem = {
        acctValues: { total: compareRollupAcct.total, values: compareRollupAcct.values },
        id: divDeptRollupDoc.id,
        name: "Total",
      };
      // create the temp item for the base version rollup & attempt to populate with values from base version
      const baseRollupTemp: TempAcctItem = { acctValues: { total: 0, values: utils.getValuesArray() }, id: divDeptRollupDoc.id, name: "Total" };
      const baseRollupDoc = await dbTx.get(baseVersionRef.collection(level).doc(divDeptRollupDoc.id));
      if (baseRollupDoc.exists) {
        baseRollupTemp.acctValues.total = (baseRollupDoc.data() as viewModel.pnlAggregateDoc).total;
        baseRollupTemp.acctValues.values = (baseRollupDoc.data() as viewModel.pnlAggregateDoc).values;
      }

      // query both versions, store the document and push the ID in the array if it doesn't exist yet
      const compAcctIds: string[] = [];
      const compAcctList: CompAccts = { compare: [], base: [] };

      if (level === "div") {
        const queryParams: WhereCond[] = [
          { field: "acct", cond: compareRollupAcct.acct },
          { field: "div", cond: compareRollupAcct.div },
        ];
        await getLineAccounts(dbTx, compareVersionRef, compAcctIds, compAcctList.compare, "dept", "equal", undefined, queryParams);
        await getLineAccounts(dbTx, baseVersionRef, compAcctIds, compAcctList.base, "dept", "equal", undefined, queryParams);
      } else if (compareRollupAcct.group && compareRollupAcct.group_children) {
        await getLineAccounts(dbTx, compareVersionRef, compAcctIds, compAcctList.compare, "dept", "in", compareRollupAcct.group_children);
        await getLineAccounts(dbTx, baseVersionRef, compAcctIds, compAcctList.base, "dept", "in", compareRollupAcct.group_children);
      } else if (level === "dept" && compareRollupAcct.dept) {
        const queryParams: WhereCond[] = [
          { field: "parent_rollup.acct", cond: compareRollupAcct.acct },
          { field: "dept", cond: compareRollupAcct.dept },
        ];
        await getLineAccounts(dbTx, compareVersionRef, compAcctIds, compAcctList.compare, "dept", "equal", undefined, queryParams);
        await getLineAccounts(dbTx, baseVersionRef, compAcctIds, compAcctList.base, "dept", "equal", undefined, queryParams);
      } else throw new Error("[divDeptCollection] No valid option to query line accounts. Nothing added to compSection.");

      compSections.push({
        rollup: createAccountComp(divDeptRollupDoc.id, { base: [baseRollupTemp], compare: [compareRollupTemp] }, level),
        children: createCompChildren(compAcctIds, compAcctList, "dept"),
      });
    }
  } catch (error) {
    throw new Error(`Error ocurred in [divDeptCollection]: ${error}`);
  }
}

async function pnlRollupCollection(
  options: compModel.VersionCompWithUser,
  dbTx: FirebaseFirestore.Transaction,
  compareVersionRef: FirebaseFirestore.DocumentReference,
  baseVersionRef: FirebaseFirestore.DocumentReference,
  compSections: compModel.CompSection[]
) {
  try {
    // get all rollups from the compare version
    const rollupAcctDocs = await dbTx.get(compareVersionRef.collection("pnl"));
    for (const pnlRollupDoc of rollupAcctDocs.docs) {
      // get the pnl document data & create the minimal account object used across all levels
      const pnlRollupAcct = pnlRollupDoc.data() as viewModel.pnlAggregateDoc;
      const compareRollupTemp: TempAcctItem = {
        acctValues: { total: pnlRollupAcct.total, values: pnlRollupAcct.values },
        id: pnlRollupDoc.id,
        name: "Total",
      };
      // create the temp item for the base version rollup & attempt to populate with values from bas eversion
      const baseRollupTemp: TempAcctItem = { acctValues: { total: 0, values: utils.getValuesArray() }, id: pnlRollupDoc.id, name: "Total" };
      const baseRollupDoc = await dbTx.get(baseVersionRef.collection("pnl").doc(pnlRollupDoc.id));
      if (baseRollupDoc.exists) {
        baseRollupTemp.acctValues.total = (baseRollupDoc.data() as viewModel.pnlAggregateDoc).total;
        baseRollupTemp.acctValues.values = (baseRollupDoc.data() as viewModel.pnlAggregateDoc).values;
      }

      // get the list of child accounts for this rollup
      const childAcctsToQuery = pnlRollupAcct.child_accts;

      // query both versions, store the document and push the ID in the array if it doesn't exist yet
      const compAcctIds: string[] = [];
      const compAcctList: CompAccts = { compare: [], base: [] };

      await getLineAccounts(dbTx, compareVersionRef, compAcctIds, compAcctList.compare, "div", "in", childAcctsToQuery);
      await getLineAccounts(dbTx, baseVersionRef, compAcctIds, compAcctList.base, "div", "in", childAcctsToQuery);

      compSections.push({
        rollup: createAccountComp(pnlRollupDoc.id, { base: [baseRollupTemp], compare: [compareRollupTemp] }, "pnl"),
        children: createCompChildren(compAcctIds, compAcctList, "div"),
      });
    }
  } catch (error) {
    throw new Error(`Error ocurred in [pnlRollupCollection]: ${error}`);
  }
}

function createCompChildren(compAcctIds: string[], compAcctList: CompAccts, level: string) {
  try {
    const compChildren: compModel.AccountComp[] = [];
    compAcctIds.sort();

    for (const lineAcctId of compAcctIds) {
      // finally, add this to the array of line children for this comparison section
      compChildren.push(createAccountComp(lineAcctId, compAcctList, level));
    } // END PROCESSING CHILD ACCTS OF THE ROLLUP

    return compChildren;
  } catch (error) {
    throw new Error(`Error ocurred in [createCompChildren]: ${error}`);
  }
}

function createAccountComp(lineAcctId: string, compAcctList: CompAccts, level: string) {
  try {
    // init zero value sets
    let compareVals: TotalValues = { total: 0, values: utils.getValuesArray() };
    let baseVals: TotalValues = { total: 0, values: utils.getValuesArray() };
    let name = "";

    // try to find this in the compare version first
    const compareAcct = compAcctList.compare.find((acct) => {
      return acct.id === lineAcctId;
    });

    if (compareAcct) {
      compareVals = compareAcct.acctValues;
      name = compareAcct.name;
    }

    // look for the base version
    const baseAcct = compAcctList.base.find((acct) => {
      return acct.id === lineAcctId;
    });

    // save values AND static names, unless we already found them via the compareAcct
    if (baseAcct) {
      baseVals = baseAcct.acctValues;
      if (!compareAcct) name = baseAcct.name;
    }

    // Create the basic object & do the comparison for the annual total of this account
    const acctComparison: compModel.AccountComp = {
      id: lineAcctId,
      level: level,
      name: name,
      values: [],
      total: createCompRow(baseVals.total, compareVals.total),
    };
    // add the comparisons for the 12 months of this account
    for (let idx = 0; idx < compareVals.values.length; idx++) {
      acctComparison.values.push(createCompRow(baseVals.values[idx], compareVals.values[idx]));
    }

    return acctComparison;
  } catch (error) {
    throw new Error(`Error ocurred in [createAccountComp]: ${error}`);
  }
}

function createCompRow(baseValue: number, compareValue: number): compModel.CompRow {
  try {
    const variance = utils.finRound(compareValue - baseValue);

    return {
      base: baseValue,
      compare: compareValue,
      var: variance,
      pct: baseValue === 0 ? 0 : utils.finRound((variance / baseValue) * 100),
    };
  } catch (error) {
    throw new Error(`Error ocurred in [createCompRow]: ${error}`);
  }
}

async function getLineAccounts(
  dbTx: FirebaseFirestore.Transaction,
  versionRef: FirebaseFirestore.DocumentReference,
  acctIds: string[],
  acctList: TempAcctItem[],
  level: string,
  queryType: "in" | "equal",
  childAcctsToQuery?: string[],
  whereQueries?: WhereCond[]
) {
  try {
    // get compare version accounts
    let acctDocs = undefined;
    if (queryType === "in" && childAcctsToQuery) acctDocs = await dbTx.get(versionRef.collection(level).where("full_account", "in", childAcctsToQuery));
    else if (whereQueries && whereQueries.length > 0) {
      let query = versionRef.collection(level).where(whereQueries[0].field, "==", whereQueries[0].cond);
      for (let idx = 1; idx < whereQueries.length; idx++) query = query.where(whereQueries[idx].field, "==", whereQueries[idx].cond);
      acctDocs = await dbTx.get(query);
    }

    if (!acctDocs) throw new Error("[getLineAccounts] Empty query conditions. Cannot select line accounts.");

    for (const acctDoc of acctDocs.docs) {
      // add to the list of all accounts if it's not in there yet (outer join!)
      if (!acctIds.includes(acctDoc.id)) acctIds.push(acctDoc.id);

      // save the full account data in the respective array
      const acct = acctDoc.data() as planModel.accountDoc;
      acctList.push({
        id: acct.full_account,
        name: acct.class === "acct" ? `${acct.acct} - ${acct.acct_name}` : acct.divdept_name,
        acctValues: {
          total: acct.total,
          values: acct.values,
        },
      });
    }
  } catch (error) {
    throw new Error(`Error ocurred in [getLineAccounts]: ${error}`);
  }
}
