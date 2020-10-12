import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

export function validateHeader(req: functions.https.Request) {
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer ")
    ) {
      console.log("auth header found");
      return req.headers.authorization.split("Bearer ")[1];
    }
  
    return "";
  }
  
  export async function decodeAuthToken(authToken: string) {
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
  