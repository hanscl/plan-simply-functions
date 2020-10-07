import * as functions from "firebase-functions";
const cors = require("cors")({ origin: true });
//const key = require("../alert-condition-291223-fe5b366c5ed9.json");

export const createVersionFromExisting = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
        console.log(`Executing createVersionFromExisting`);
    } catch (error) {
      console.log(`Error while duplicating version: ${JSON.stringify(error)}`);
    }
  });
});
