import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as driver_model from "./driver_model";
import * as view_model from "./view_model";
//const cors = require("cors")({ origin: true });

const db = admin.firestore();

interface contextParams {
  entity: string;
  plan_id: string;
  version_id: string;
  account: string;
}

export const getValidDriverAccounts = functions.https.onRequest(
  async (request, response) => {
    try {
      const context_params = request.body as contextParams;
      console.log(
        `Running function for entity ${context_params.entity} and version ${context_params.version_id} with account ${context_params.account}`
      );

      // STEP 1: Query the drivers for this version to see if there any accounts that are dependent on the account we are creating drivers for
      const dep_accounts: string[] = [];
      const driven_acct_snaps = await db
        .collection(
          `entities/${context_params.entity}/drivers/${context_params.version_id}/dept`
        )
        .where("ref_accts", "array-contains", context_params.account)
        .get();
      for (const driver_def_doc of driven_acct_snaps.docs)
        dep_accounts.push(driver_def_doc.id);

      // STEP 2: query the company view for this version and build the new JSON object
      const valid_driver_accounts: driver_model.validDriverAccts = {
        ...context_params,
      };
      valid_driver_accounts.lines = [];

      const views_for_version_snap = await db
        .collection(`entities/${context_params.entity}/views`)
        .where("plan_id", "==", context_params.plan_id)
        .where("version_id", "==", context_params.version_id)
        .get();
      if (views_for_version_snap.empty)
        throw new Error(
          `Unable to find any view document for ${JSON.stringify(
            context_params
          )}`
        );

      const view_for_company_snap = await views_for_version_snap.docs[0].ref
        .collection("by_org_level")
        .where("level", "==", "company")
        .get();

      if (view_for_company_snap.empty)
        throw new Error(`Unable to find a company view`);

      const view_sect_snaps = await view_for_company_snap.docs[0].ref
        .collection("sections")
        .get();

      for (const view_sect_doc of view_sect_snaps.docs) {
        const view_sect = view_sect_doc.data() as view_model.viewSection;
        if (
          view_sect.totals_id === undefined ||
          view_sect.totals_level === undefined
        )
          continue;

        valid_driver_accounts.lines.push({
          child_accts: view_sect.lines,
          acct: view_sect.totals_id,
          level: view_sect.totals_level,
          desc: `Total ${view_sect.name}`,
          can_select: true,
        });
      }

      console.log(`Build the new driver account JSON object: ${JSON.stringify(valid_driver_accounts)}`);
      // STEP 3:

      response.send(`Function completed successfully.`);

    } catch (error) {
      console.log(`Error occured building driver account object: ${error}`);
      response.sendStatus(500);
    }
  }
);
