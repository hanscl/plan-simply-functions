import * as cloudTasks from '@google-cloud/tasks';
import * as protos from '@google-cloud/tasks/build/protos/protos';

import * as config from './config';

const urlMappings = [
  { source: 'version-fullcalc-async', target: 'versionFullCalcGCT' },
  { source: 'recalc-rebuild-async', target: 'recalcRebuildVersionGCT' },
  { source: 'version-rollup-recalc', target: 'versionRollupRecalcGCT' },
  { source: 'roll-version-async', target: 'rollVersionGCT' },
  { source: 'rolling-forecast-async', target: 'rollingForecastGCT' },
];

export async function dispatchGCloudTask(
  payload: object,
  urlExt: string,
  queue: 'recalc' | 'general',
  inSeconds?: number
) {
  try {
    // Instantiates a client.
    const client = new cloudTasks.CloudTasksClient();

    const projectId = config.getProjectId();
    if (!projectId) throw new Error('No Project ID found');

    const location = config.taskQueueLoc;
    //    const url = `https://${projectId}.web.app/${urlExt}`;
    const filteredUrlMap = urlMappings.filter((urlMap) => urlMap.source === urlExt);
    if (filteredUrlMap.length === 0) {
      throw new Error(`Could not find urlMapping for ${urlExt}`);
    }

    const url = `https://${location}-${projectId}.cloudfunctions.net/${filteredUrlMap[0].target}`;
    console.log(`Dispatching Cloud Task for ${urlExt} to ${url}`);

    const serviceAccountEmail = `cloud-tasks@${projectId}.iam.gserviceaccount.com`;

    // Construct the fully qualified queue name.
    const parent = client.queuePath(projectId, location, queue);

    const httpReq = {
      httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
      url: url,
      body: '',
      oidcToken: { serviceAccountEmail },
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (payload) {
      httpReq.body = Buffer.from(JSON.stringify(payload)).toString('base64');
      //httpReq.body = JSON.stringify(payload);
    }

    let task = undefined;

    if (inSeconds) {
      task = {
        httpRequest: httpReq,
        scheduleTime: { seconds: inSeconds + Date.now() / 1000 },
      };
    } else {
      task = { httpRequest: httpReq };
    }

    // Send create task request.
    console.log(`Sending task: ${JSON.stringify(task)}`);
    const request = { parent, task };
    console.log(JSON.stringify(request));
    const [response] = await client.createTask(request);
    console.log(`Created task ${response.name}`);
    return Promise.resolve();
  } catch (error) {
    console.log(`Error during task dispatch for queue ${queue} and url ${urlExt}: ${error}`);
    return Promise.reject(new Error('Task dispatch failed.'));
  }
}
