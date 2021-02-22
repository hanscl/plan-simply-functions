import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as gAuth from 'google-auth-library';
import * as config from '../config';

export function validateHeader(req: functions.https.Request) {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    console.log('auth header found');
    return req.headers.authorization.split('Bearer ')[1];
  }

  return '';
}

export async function decodeAuthToken(authToken: string) {
  return admin
    .auth()
    .verifyIdToken(authToken)
    .then((decodedToken) => {
      // decode the current user's auth token
      return decodedToken.uid;
    })
    .catch((reason) => {
      return undefined;
    });
}


export async function verifyCloudTaskRequest(request: functions.https.Request, clientId: string) {
  try {
    // decode the id token
    const oidcToken = validateHeader(request);

    const projectId = config.getProjectId();
    if (!projectId) throw new Error('No Project ID found');

    // const host = `${projectId}.web.app`;
    const client = new gAuth.OAuth2Client();

    const location = config.taskQueueLoc;
    const filteredUrlMap =config.urlMappings.filter((urlMap) => urlMap.source === clientId);
    if (filteredUrlMap.length === 0) {
      throw new Error(`Could not find urlMapping for ${clientId}`);
    }

    //const aud = `https://${projectId}.web.app/${clientId}`;
    const aud = `https://${location}-${projectId}.cloudfunctions.net/${filteredUrlMap[0].target}`;

    console.log(`assumed audience: ${aud}`);

    const ticket = await client.verifyIdToken({
      idToken: oidcToken,
      audience: aud,
    });

    const payload = ticket.getPayload();
    if (!payload) throw new Error(`OIDC Token did not have payload`);

    // verify that the request came from the correct service account
    if (payload.email !== `cloud-tasks@${projectId}.iam.gserviceaccount.com`)
      throw new Error(`Cloud Task Request made by invalid email: ${payload.email}. Do not process!`);

    return Promise.resolve();
  } catch (error) {
    console.log(`Error occured while verifying Cloud Task Request: ${error}`);
    return Promise.reject(new Error('Verify Cloud Task Request failed.'));
  }
}
