import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as driver_model from "./driver_model";
import * as view_model from "./view_model";
import * as config from "./config";
const cors = require("cors")({ origin: true });

const db = admin.firestore();

interface contextParams {
  entity: string;
  plan_id: string;
  version_id: string;
  account: string;
}

export const getValidDriverAccounts = functions.region(config.cloudFuncLoc).https.onRequest(
  async (request, response) => {
    cors(request, response, async () => {
      try {
        response.set("Access-Control-Allow-Origin", "*");
        response.set("Access-Control-Allow-Credentials", "true");

        if (request.method === "OPTIONS") {
          response.set("Access-Control-Allow-Methods", "GET");
          response.set("Access-Control-Allow-Headers", "Authorization");
          response.set("Access-Control-Max-Age", "3600");
          response.status(204).send("");

          return;
        }

        //     let requestedUid = request.body.     // resource the user is requsting to modify
        const authToken = validateHeader(request); // current user encrypted

        if (!authToken) {
          response.status(403).send("Unauthorized! Missing auth token!");
          return;
        }

        console.log(`USE THIS:[${authToken}]`);
        const dec_token = await decodeAuthToken(authToken);

        if(dec_token === undefined) {
          response.status(403).send("Invalid token.");
          return;
        }
    
        console.log(`uid: ${dec_token}`);

        const user_snap = await db.doc(`users/${dec_token}`).get();
        if(!user_snap.exists) {
          response.status(403).send("User not known in this system!");
          return;
        }

        const context_params = request.body as contextParams;
        console.log(
          `Running function for entity ${context_params.entity} and version ${context_params.version_id} with account ${context_params.account}`
        );

        // STEP 1: Query the drivers for this version to see if there any accounts that are dependent on the account we are creating drivers for
        const dep_accounts: string[] = [context_params.account];
        const driven_acct_snaps = await db
          .collection(
            `entities/${context_params.entity}/drivers/${context_params.version_id}/dept`
          )
          .where("ref_accts", "array-contains", context_params.account)
          .get();
        for (const driver_def_doc of driven_acct_snaps.docs)
          dep_accounts.push(driver_def_doc.id);

        console.log(
          `found dependent accounts which cannot be used as a driver for this account: ${JSON.stringify(
            dep_accounts
          )}`
        );

        // STEP 2: query the company view for this version and build the new JSON object
        const valid_driver_accounts: driver_model.validDriverAccts = {
          ...context_params,
        };
        valid_driver_accounts.sections = [];

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
          .orderBy("position", "asc")
          .get();

        for (const view_sect_doc of view_sect_snaps.docs) {
          const view_sect = view_sect_doc.data() as view_model.viewSection;
          valid_driver_accounts.sections.push(view_sect);
          console.log(JSON.stringify(view_sect));
        }

        // console.log(
        //   `Built the new driver account JSON object: ${JSON.stringify(
        //     valid_driver_accounts
        //   )}`
        // );
        // STEP 3: determine if accounts can be selected or not
        processDriverSections(valid_driver_accounts.sections, dep_accounts);

        console.log(
          `Updated JSON object with can_select flags: ${JSON.stringify(
            valid_driver_accounts
          )}`
        );

        response.json(valid_driver_accounts).status(200).send();

        //  response.send(`Function completed successfully.`);
      } catch (error) {
        console.log(`Error occured building driver account object: ${error}`);
        response.sendStatus(500);
      }
    });
  }
);

function processDriverSections(
  driver_account_sections: view_model.viewSection[],
  dep_accounts: string[]
) {
  for (const section of driver_account_sections) {
    // if the section has no children we cannot determine if it's circular => disable for now
    // TODO -- might have to evaluate these using the account hiearchy etc etc.
    if (section.lines === undefined) {
      section.can_select = false;
    } else {
      for (const line of section.lines) {
        const can_select = evaluateAccount(line, dep_accounts);
        if (can_select === false) section.can_select = false;
        else
          section.can_select =
            section.can_select === true || section.can_select === undefined
              ? true
              : false;
      }
    }
  }
}

function evaluateAccount(
  acct_obj: view_model.viewChild,
  dep_accounts: string[]
) {
  // on n-level evaluate against dependent accounts, set and return the result
  if (acct_obj.child_accts === undefined) {
    acct_obj.can_select = !dep_accounts.includes(acct_obj.acct);
    return acct_obj.can_select;
  }

  for (const child_acct of acct_obj.child_accts) {
    const can_select_child = evaluateAccount(child_acct, dep_accounts);
    if (can_select_child === false) acct_obj.can_select = false;
    else
      acct_obj.can_select =
        acct_obj.can_select === true || acct_obj.can_select === undefined
          ? true
          : false;
  }

  return acct_obj.can_select;
}

function validateHeader(req: functions.https.Request) {
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer ")
  ) {
    console.log("auth header found");
    return req.headers.authorization.split("Bearer ")[1];
  }

  return "";
}

function decodeAuthToken(authToken: string) {
  return admin
    .auth()
    .verifyIdToken(authToken)
    .then((decodedToken) => {
      // decode the current user's auth token
      return decodedToken.uid;
    })
    .catch(reason => {
      return undefined;
    });
}
