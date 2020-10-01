import * as functions from "firebase-functions";
//import * as admin from "firebase-admin";
const cors = require("cors")({ origin: true });

export const getValidDriverAccounts = functions.https.onRequest(
  async (req, res) => {
    cors(req, res, () => {
      // expecting object: {entity: string, version: string, account: string}
      console.log(JSON.stringify(req.body));
      return;
    });
  }
);
