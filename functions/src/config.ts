import * as functions from "firebase-functions";
export const cloudFuncLoc = functions.config().app.env === 'prod' ? 'europe-west1' : 'us-central1';

export function getProjectId(): string | undefined {
    const fb_config = process.env.FIREBASE_CONFIG;
    if (fb_config === undefined) {
      console.log(`FIREBASE_CONFIG is undefined`);
      return undefined;
    }
    
    return(JSON.parse(fb_config).projectId);
}
