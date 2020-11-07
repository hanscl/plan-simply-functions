import * as functions from "firebase-functions";
const cors = require("cors")({ origin: true });
import * as config from "./config";

export const createVersionFromExisting = functions.region(config.cloudFuncLoc).https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
        console.log(`Executing createVersionFromExisting`);
    } catch (error) {
      console.log(`Error while duplicating version: ${JSON.stringify(error)}`);
    }
  });
});
