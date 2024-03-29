import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import * as https_utils from '../utils/https_utils';
import * as utils from '../utils/utils';
import * as config from '../config';
import * as laborModel from './labor_model';
import * as laborCalc from './labor_calc';
import * as entityModel from '../entity_model';
import * as planModel from '../plan_model';
import * as cloudTasks from '../gcloud_task_dispatch';
import * as rollupRecalc from '../version_rollup_recalc_master';
import { deleteDriverDefinition } from '../driver_doc_change';
import {userDoc} from '../user_model';

const cors = require('cors')({ origin: true });

const db = admin.firestore();

export const laborPositionRequest = functions.region(config.cloudFuncLoc).https.onRequest(async (request, response) => {
  cors(request, response, async () => {
    try {
      response.set('Access-Control-Allow-Origin', '*');
      response.set('Access-Control-Allow-Credentials', 'true');

      if (request.method === 'OPTIONS') {
        response.set('Access-Control-Allow-Methods', 'GET');
        response.set('Access-Control-Allow-Headers', 'Authorization');
        response.set('Access-Control-Max-Age', '3600');
        response.status(204).send('');

        return;
      }

      const authToken = https_utils.validateHeader(request); // current user encrypted

      if (!authToken) {
        response.status(403).send('Unauthorized! Missing auth token!');
        return;
      }

      const uid = await https_utils.decodeAuthToken(authToken);

      if (uid === undefined) {
        response.status(403).send('Invalid token.');
        return;
      }

      console.log(`uid: ${uid}`);
      console.log(`Cloud Function Deploy Location: ${config.cloudFuncLoc}`);

      const user_snap = await db.doc(`users/${uid}`).get();
      if (!user_snap.exists) {
        response.status(403).send('User not known in this system!');
        return;
      }

      const laborPosRequest = request.body as laborModel.SavePositionRequest;

      const user = user_snap.data() as userDoc;
      if(!user.roles.includes('finance') && !user.entities_write.includes(laborPosRequest.entityId)) {
        response.status(403).send({ result: `User not permissioned to edit this entity.` });
        return;
      }

      console.log(`Processing SavePositionRequest: ${JSON.stringify(laborPosRequest)}`);

      // make sure the request is valid. This will throw an error if it is not.
      checkRequestIsValid(laborPosRequest);

      // Get the labor calcs object from the entity
      const entityDoc = await db.doc(`entities/${laborPosRequest.entityId}`).get();
      if (!entityDoc.exists) throw new Error(`Entity document not found for ${laborPosRequest.entityId}`);
      const entityData = entityDoc.data() as entityModel.entityDoc;
      const entityLaborDefs = entityData.labor_settings;
      if (!entityLaborDefs) throw new Error('Missing Labor Settings on Entity');

      checkEntityLaborDefs(entityLaborDefs);

      // get the labor version and save it to the position request
      const versionSnapshot = await db
        .doc(
          `entities/${laborPosRequest.entityId}/plans/${laborPosRequest.planId}/versions/${laborPosRequest.versionId}`
        )
        .get();
      if (!versionSnapshot.exists)
        throw new Error(`Invalid plan-version for entity: ${JSON.stringify(laborPosRequest)}`);
      const laborVersion = (versionSnapshot.data() as planModel.versionDoc).labor_version;

      if (!laborVersion) {
        laborPosRequest.laborVersion = 1;
      } else {
        laborPosRequest.laborVersion = laborVersion;
      }

      if (laborPosRequest.action === 'create' || laborPosRequest.action === 'update') {
        await createOrUpdateLaborPosition(laborPosRequest, entityLaborDefs);
      } else if (laborPosRequest.action === 'delete' && laborPosRequest.positionId) {
        await deleteLaborPosition(laborPosRequest, entityLaborDefs);
      } else
        throw new Error(
          `Unable to process request to save Labor position. Invalid action specified: '${laborPosRequest.action}'. Valid actions are 'create', 'update', 'save'`
        );

      response.status(200).send({ result: `Labor position request processed successfully.` });

      return Promise.resolve();
    } catch (error) {
      console.log(`Error occured while saving/deleting labor position: ${error}`);
      response
        .status(500)
        .send({ result: `Error occured while trying to save/delete position. Please contact support` });
      return Promise.reject(new Error('Error occured while saving/deleting labor position.'));
    }
  });
});

async function deleteLaborPosition(posReq: laborModel.SavePositionRequest, entityLaborDefs: entityModel.LaborSettings) {
  try {
    // begin transaction - lock the version document until we're done
    await db.runTransaction(async (laborTx) => {
      // update the income statement
      await updateLaborAccounts(
        laborTx,
        posReq,
        utils.getValuesArray(),
        utils.getValuesArray(),
        utils.getValuesArray(),
        entityLaborDefs.default_accts
      );
      // save document
      laborTx.delete(db.doc(`entities/${posReq.entityId}/labor/${posReq.versionId}/positions/${posReq.positionId}`));
    });
  } catch (error) {
    throw new Error(`Error in [deleteLaborPosition]: ${error}`);
  }
}

async function createOrUpdateLaborPosition(
  posReq: laborModel.SavePositionRequest,
  entityLaborDefs: entityModel.LaborSettings
) {
  try {
    if (!posReq.data) throw new Error('No data to create new position');

    // get the days in the month for this plan
    const daysInMonths = await getDaysInMonths(posReq);

    // calculate wages
    const wages = getWages(posReq, entityLaborDefs.wage_method, daysInMonths);
    if (!wages) throw new Error('Unable to calculate wages.');

    // calculate bonus
    const bonus = laborCalc.calculateBonus(posReq.data, wages.values);

    // calculate social security
    const socialsec = laborCalc.calculateSocialSec(posReq.data, wages.values);

    // calculate avg FTEs
    const ftes = laborCalc.calculateAvgFTEs(daysInMonths, posReq.data.ftes.values);

    // begin transaction - lock the version document until we're done
    await db.runTransaction(async (laborTx) => {
      // update the income statement
      await updateLaborAccounts(
        laborTx,
        posReq,
        wages.values,
        bonus.values,
        socialsec.values,
        entityLaborDefs.default_accts
      );
      // save document
      await savePosition(laborTx, posReq, wages, bonus, socialsec, ftes);
    });
  } catch (error) {
    throw new Error(`Error in [createLaborPosition]: ${error}`);
  }
}

async function updateLaborAccounts(
  laborTx: FirebaseFirestore.Transaction,
  posReq: laborModel.SavePositionRequest,
  wagesAfter: number[],
  bonusAfter: number[],
  socialsecAfter: number[],
  laborAccts: entityModel.LaborDefaultAccounts
) {
  try {
    if (posReq.action !== 'delete' && !posReq.data) throw new Error('Need position data to update accounts');

    let wagesBefore = utils.getValuesArray();
    let bonusBefore = utils.getValuesArray();
    let socialsecBefore = utils.getValuesArray();

    let positionData: laborModel.PositionDoc | undefined = undefined;

    // get the existing values unless we are creating a new position
    if ((posReq.action === 'delete' || posReq.action === 'update') && posReq.positionId) {
      const positionDoc = await laborTx.get(
        db.doc(`entities/${posReq.entityId}/labor/${posReq.versionId}/positions/${posReq.positionId}`)
      );
      if (!positionDoc)
        throw new Error(`Position document ${posReq.positionId} not found for version ${posReq.versionId}`);
      // we have a position -- get the existing calculated values
      positionData = positionDoc.data() as laborModel.PositionDoc;
      wagesBefore = positionData.wages.values;
      bonusBefore = positionData.bonus.values;
      socialsecBefore = positionData.socialsec.values;
    }

    // get the entity doc and pass to the recalc function
    const entityDoc = await db.doc(`entities/${posReq.entityId}`).get();
    const entityData = entityDoc.data() as entityModel.entityDoc;
    const acctFormatString = entityData.full_account;

    let newPosDiv = '';
    if (posReq.action !== 'delete' && posReq.data) newPosDiv = await getPositionDiv(posReq.entityId, posReq.data.dept);

    // TODO: optimize this code, please
    if (posReq.action === 'delete') {
      if (!positionData) throw new Error('Unable to locate position to be deleted');

      await resetGLAccountAndLockStatus(
        posReq.entityId,
        posReq.planId,
        posReq.versionId,
        positionData.div,
        positionData.dept,
        positionData.acct,
        [acctFormatString],
        'removed'
      );

      await scheduleCloudTaskRecalc(
        entityData,
        posReq,
        positionData.acct,
        positionData.dept,
        positionData.div,
        wagesBefore,
        wagesAfter
      );

      if (posReq.laborVersion > 1) {
        await scheduleCloudTaskRecalc(
          entityData,
          posReq,
          laborAccts.bonus,
          positionData.dept,
          positionData.div,
          bonusBefore,
          bonusAfter
        );
        await scheduleCloudTaskRecalc(
          entityData,
          posReq,
          laborAccts.socialsec,
          positionData.dept,
          positionData.div,
          socialsecBefore,
          socialsecAfter
        );
      }
    } else if (posReq.action === 'create') {
      if (!posReq.data) throw new Error('Need data object to create position');
      const acctComponents = { div: newPosDiv, dept: posReq.data.dept };
      await deleteDriverDefinition(
        posReq.entityId,
        posReq.planId,
        posReq.versionId,
        utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: posReq.data?.acct }),
        'labor'
      );

      await resetGLAccountAndLockStatus(
        posReq.entityId,
        posReq.planId,
        posReq.versionId,
        newPosDiv,
        posReq.data.dept,
        posReq.data?.acct,
        [acctFormatString],
        'added'
      );

      await scheduleCloudTaskRecalc(
        entityData,
        posReq,
        posReq.data.acct,
        posReq.data.dept,
        newPosDiv,
        wagesBefore,
        wagesAfter
      );
      if (posReq.laborVersion > 1) {
        await deleteDriverDefinition(
          posReq.entityId,
          posReq.planId,
          posReq.versionId,
          utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: laborAccts.bonus }),
          'entry'
        );
        await scheduleCloudTaskRecalc(
          entityData,
          posReq,
          laborAccts.bonus,
          posReq.data.dept,
          newPosDiv,
          bonusBefore,
          bonusAfter
        );
        await deleteDriverDefinition(
          posReq.entityId,
          posReq.planId,
          posReq.versionId,
          utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: laborAccts.socialsec }),
          'entry'
        );
        await scheduleCloudTaskRecalc(
          entityData,
          posReq,
          laborAccts.socialsec,
          posReq.data.dept,
          newPosDiv,
          socialsecBefore,
          socialsecAfter
        );
      }
    } else {
      if (!positionData || !posReq.data) throw new Error('Need existing position and data object to update position');
      if (posReq.data.dept !== positionData.dept) {
        await resetGLAccountAndLockStatus(
          posReq.entityId,
          posReq.planId,
          posReq.versionId,
          positionData.div,
          positionData.dept,
          positionData.acct,
          [acctFormatString],
          'removed'
        );

        // delete values from previous account
        await scheduleCloudTaskRecalc(
          entityData,
          posReq,
          positionData.acct,
          positionData.dept,
          positionData.div,
          wagesBefore,
          utils.getValuesArray()
        );
        if (posReq.laborVersion > 1) {
          await scheduleCloudTaskRecalc(
            entityData,
            posReq,
            laborAccts.bonus,
            positionData.dept,
            positionData.div,
            bonusBefore,
            utils.getValuesArray()
          );
          await scheduleCloudTaskRecalc(
            entityData,
            posReq,
            laborAccts.socialsec,
            positionData.dept,
            positionData.div,
            socialsecBefore,
            utils.getValuesArray()
          );
        }
        // add values to new account
        const acctComponents = { div: newPosDiv, dept: posReq.data.dept };
        await deleteDriverDefinition(
          posReq.entityId,
          posReq.planId,
          posReq.versionId,
          utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: posReq.data?.acct }),
          'labor'
        );

        await resetGLAccountAndLockStatus(
          posReq.entityId,
          posReq.planId,
          posReq.versionId,
          newPosDiv,
          posReq.data.dept,
          posReq.data?.acct,
          [acctFormatString],
          'added'
        );

        await scheduleCloudTaskRecalc(
          entityData,
          posReq,
          posReq.data.acct,
          posReq.data.dept,
          newPosDiv,
          utils.getValuesArray(),
          wagesAfter
        );
        if (posReq.laborVersion > 1) {
          await deleteDriverDefinition(
            posReq.entityId,
            posReq.planId,
            posReq.versionId,
            utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: laborAccts.bonus }),
            'entry'
          );
          await scheduleCloudTaskRecalc(
            entityData,
            posReq,
            laborAccts.bonus,
            posReq.data.dept,
            newPosDiv,
            utils.getValuesArray(),
            bonusAfter
          );
          await deleteDriverDefinition(
            posReq.entityId,
            posReq.planId,
            posReq.versionId,
            utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: laborAccts.socialsec }),
            'entry'
          );
          await scheduleCloudTaskRecalc(
            entityData,
            posReq,
            laborAccts.socialsec,
            posReq.data.dept,
            newPosDiv,
            utils.getValuesArray(),
            socialsecAfter
          );
        }
      } else if (posReq.data.acct !== positionData.acct) {
        await resetGLAccountAndLockStatus(
          posReq.entityId,
          posReq.planId,
          posReq.versionId,
          positionData.div,
          positionData.dept,
          positionData.acct,
          [acctFormatString],
          'removed'
        );

        // new wage account only -- process both
        await scheduleCloudTaskRecalc(
          entityData,
          posReq,
          positionData.acct,
          positionData.dept,
          positionData.div,
          wagesBefore,
          utils.getValuesArray()
        );
        // add values to new account
        const acctComponents = { div: newPosDiv, dept: posReq.data.dept };
        await deleteDriverDefinition(
          posReq.entityId,
          posReq.planId,
          posReq.versionId,
          utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: posReq.data?.acct }),
          'labor'
        );

        await resetGLAccountAndLockStatus(
          posReq.entityId,
          posReq.planId,
          posReq.versionId,
          newPosDiv,
          posReq.data.dept,
          posReq.data?.acct,
          [acctFormatString],
          'added'
        );

        await scheduleCloudTaskRecalc(
          entityData,
          posReq,
          posReq.data.acct,
          posReq.data.dept,
          newPosDiv,
          utils.getValuesArray(),
          wagesAfter
        );
        // for bonus & social sec just update the existing account
        if (posReq.laborVersion > 1) {
          await deleteDriverDefinition(
            posReq.entityId,
            posReq.planId,
            posReq.versionId,
            utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: laborAccts.bonus }),
            'entry'
          );
          await scheduleCloudTaskRecalc(
            entityData,
            posReq,
            laborAccts.bonus,
            posReq.data.dept,
            newPosDiv,
            bonusBefore,
            bonusAfter
          );
          await deleteDriverDefinition(
            posReq.entityId,
            posReq.planId,
            posReq.versionId,
            utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: laborAccts.socialsec }),
            'entry'
          );
          await scheduleCloudTaskRecalc(
            entityData,
            posReq,
            laborAccts.socialsec,
            posReq.data.dept,
            newPosDiv,
            socialsecBefore,
            socialsecAfter
          );
        }
      } else {
        // dept AND acct unchanged; no acct reset or lock update necessary
        // add values to new account
        const acctComponents = { div: newPosDiv, dept: posReq.data.dept };
        await deleteDriverDefinition(
          posReq.entityId,
          posReq.planId,
          posReq.versionId,
          utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: posReq.data?.acct }),
          'labor'
        );
        // all three accounts and the dept are the same. Just update those accounts
        await scheduleCloudTaskRecalc(
          entityData,
          posReq,
          posReq.data.acct,
          posReq.data.dept,
          newPosDiv,
          wagesBefore,
          wagesAfter
        );
        if (posReq.laborVersion > 1) {
          await deleteDriverDefinition(
            posReq.entityId,
            posReq.planId,
            posReq.versionId,
            utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: laborAccts.bonus }),
            'entry'
          );
          await scheduleCloudTaskRecalc(
            entityData,
            posReq,
            laborAccts.bonus,
            posReq.data.dept,
            newPosDiv,
            bonusBefore,
            bonusAfter
          );
          await deleteDriverDefinition(
            posReq.entityId,
            posReq.planId,
            posReq.versionId,
            utils.buildFullAccountString([acctFormatString], { ...acctComponents, acct: laborAccts.socialsec }),
            'entry'
          );
          await scheduleCloudTaskRecalc(
            entityData,
            posReq,
            laborAccts.socialsec,
            posReq.data.dept,
            newPosDiv,
            socialsecBefore,
            socialsecAfter
          );
        }
      }
    }
  } catch (error) {
    throw new Error(`Error in [updateLaborAccounts]: ${error}`);
  }
}

async function scheduleCloudTaskRecalc(
  entityData: entityModel.entityDoc,
  posReq: laborModel.SavePositionRequest,
  acctId: string,
  deptId: string,
  divId: string,
  valsBefore: number[],
  valsAfter: number[]
) {
  try {
    const acctChanges = {
      diff_by_month: [],
      diff_total: 0,
      months_changed: [],
      operation: 1,
    };

    console.log(
      `[BEFORE]: ValsBefore: ${JSON.stringify(valsBefore)}, valsAfter: ${JSON.stringify(
        valsAfter
      )}, acctChanges: ${JSON.stringify(acctChanges)}`
    );

    console.log(`[posReq]: ${JSON.stringify(posReq)}`);

    const ret = utils.getValueDiffsByMonth(
      valsBefore,
      valsAfter,
      acctChanges.diff_by_month,
      acctChanges.months_changed
    );
    if (ret === undefined) {
      console.log(
        `[AFTER]: ValsBefore: ${JSON.stringify(valsBefore)}, valsAfter: ${JSON.stringify(
          valsAfter
        )}, acctChanges: ${JSON.stringify(acctChanges)}`
      );
      throw new Error('Unable to calculate difference in values');
    }

    acctChanges.diff_total = ret;

    // build the full account
    const fullAcct = utils.buildFullAccountString([entityData.full_account], {
      acct: acctId,
      div: divId,
      dept: deptId,
    });
    console.log(`Full account: ${fullAcct}`);

    // create the recalc request object
    const recalcReq: rollupRecalc.RecalcRequest = {
      caller_id: 'labor',
      user_initiated: false,
      recalc_params: {
        acct_id: fullAcct,
        dept: deptId,
        entity_id: posReq.entityId,
        plan_id: posReq.planId,
        version_id: posReq.versionId,
        values: [],
      },
      passed_acct_changes: acctChanges,
    };

    console.log(`recalc Request: ${JSON.stringify(recalcReq)}`);

    // schedule the cloud task
    await cloudTasks.dispatchGCloudTask(recalcReq, 'version-rollup-recalc', 'recalc');
  } catch (error) {
    throw new Error(`Error occured in [scheduleCloudTaskRecalc]: ${error}`);
  }
}

async function savePosition(
  laborTx: FirebaseFirestore.Transaction,
  posReq: laborModel.SavePositionRequest,
  wages: laborModel.LaborCalc,
  bonus: laborModel.LaborCalc,
  socialsec: laborModel.LaborCalc,
  ftes: laborModel.LaborCalc
) {
  try {
    if (!posReq.data) throw new Error('Must have position data for saving document');

    // make sure the labor document exists for this version
    const laborDocRef = await createVersionLaborDoc(posReq);

    console.log(`Writing Labor request: ${JSON.stringify(posReq)}`);

    // create the document
    const laborDoc: laborModel.PositionDoc = {
      comments: '',
      acct: posReq.data.acct,
      dept: posReq.data.dept,
      div: await getPositionDiv(posReq.entityId, posReq.data.dept),
      title: posReq.data.title,
      pay_type: posReq.data.pay_type,
      fte_factor: posReq.data.fte_factor,
      ftes: ftes,
      rate: laborCalc.calculateRate(posReq.data),
      wages: wages,
      // set bonus and social security to 'None' and 0 if this is a plan-version with the deprecated labor model
      bonus_option: posReq.laborVersion > 1 ? posReq.data.bonus_option : 'None',
      bonus_pct: posReq.laborVersion > 1 && posReq.data.bonus_pct ? posReq.data.bonus_pct : 0,
      bonus: posReq.laborVersion > 1 ? bonus : { total: 0, values: utils.getValuesArray() },
      socialsec_pct: posReq.laborVersion > 1 ? posReq.data.socialsec_pct : 0,
      socialsec: posReq.laborVersion > 1 ? socialsec : { total: 0, values: utils.getValuesArray() },
      last_updated: admin.firestore.Timestamp.now(),
    };

    console.log(`Labor Doc before save: ${JSON.stringify(laborDoc)}`);

    // & save
    if (posReq.positionId) {
      laborTx.set(laborDocRef.collection('positions').doc(posReq.positionId), laborDoc);
    } else {
      laborTx.set(laborDocRef.collection('positions').doc(), laborDoc);
    }
  } catch (error) {
    throw new Error(`Error in [savePosition]: ${error}`);
  }
}

async function getPositionDiv(entityId: string, deptId: string): Promise<string> {
  const docPath = `entities/${entityId}/entity_structure/dept`;
  const deptDoc = await db.doc(docPath).get();
  if (!deptDoc.exists) throw new Error(`Dept definition document not found in entity structure: ${docPath}`);

  const deptDict = deptDoc.data() as entityModel.deptDict;

  const divId = deptDict[deptId].div;
  if (!divId) throw new Error(`could not find divID for ${deptId}`);

  return divId;
}

async function createVersionLaborDoc(
  posReq: laborModel.SavePositionRequest
): Promise<FirebaseFirestore.DocumentReference> {
  try {
    const laborDocRef = db.doc(`entities/${posReq.entityId}/labor/${posReq.versionId}`);

    // see if the document exists already
    const versionLaborDoc = await laborDocRef.get();
    if (!versionLaborDoc.exists) {
      await laborDocRef.set({
        plan_id: posReq.planId,
        version_id: posReq.versionId,
      });
    }

    return laborDocRef;
  } catch (error) {
    throw new Error(`Error in [createVersionLaborDoc]`);
  }
}

function getWages(
  posReq: laborModel.SavePositionRequest,
  wageMethod: string,
  daysInMonths: number[]
): laborModel.LaborCalc | undefined {
  try {
    if (posReq.data === undefined) throw new Error(`Position data is undefined`);

    if (wageMethod === 'us') {
      return laborCalc.calculateWagesUS(posReq.data, daysInMonths, posReq.data.ftes.values);
    } else if (wageMethod === 'eu') {
      return laborCalc.calculateWagesEU(posReq.data, posReq.data.ftes.values);
    } else {
      return undefined;
    }
  } catch (error) {
    throw new Error(`Error occured in [calculateWages]: ${error}`);
  }
}

async function getDaysInMonths(posReq: laborModel.SavePositionRequest): Promise<number[]> {
  const planDoc = await db.doc(`entities/${posReq.entityId}/plans/${posReq.planId}`).get();
  if (!planDoc.exists) throw new Error(`Plan ${posReq.planId} does not exist for entity ${posReq.entityId}`);
  const planData = planDoc.data() as planModel.planDoc;
  const days_in_months = utils.getDaysInMonth(planData.begin_year, planData.begin_month);

  return days_in_months;
}

function checkRequestIsValid(posReq: laborModel.SavePositionRequest) {
  try {
    if (!posReq.entityId || !posReq.versionId) throw new Error('Invalid request. Require both Entity and Version Id');

    if (!posReq.positionId && posReq.action !== 'create')
      throw new Error('Invalid request. Position ID required for updated and deletes.');

    // data object validations are only required for create and update requests
    if (posReq.action !== 'delete') {
      if (!posReq.data) throw new Error('Position data required for update and create requests.');
      if (!posReq.data.acct || !posReq.data.dept || !posReq.data.title)
        throw new Error('Acct/Dept/Title are required for update and create requests.');
      if (posReq.data.pay_type !== 'Hourly' && posReq.data.pay_type !== 'Salary')
        throw new Error('Invalid Wage Type. Must be Hourly or Salary.');
      if (!posReq.data.rate.annual && !posReq.data.rate.hourly) throw new Error('Must provide pay rate.');
      if (!['None', 'Percent', 'Value'].includes(posReq.data.bonus_option))
        throw new Error('Invalid Bonus option. Must be None, Percent or Value');
      if (posReq.data.bonus_option === 'Value' && (!posReq.data.bonus || posReq.data.bonus.values.length !== 12))
        throw new Error('Must provide bonus values!');
      if (posReq.data.bonus_option === 'Percent' && !posReq.data.bonus_pct)
        throw new Error('Must provide bonus percentage');
      if (!posReq.data.ftes || posReq.data.ftes.values.length !== 12) throw new Error('Must provide 12 months of FTEs');
    }
  } catch (error) {
    throw new Error(`Invalid request to save labor: ${error}`);
  }
}

function checkEntityLaborDefs(entityLabor: entityModel.LaborSettings) {
  try {
    if (!entityLabor.wage_method || !['us', 'eu'].includes(entityLabor.wage_method))
      throw new Error('No valid wage method defined for entity');
    if (!entityLabor.default_accts || !entityLabor.default_accts.bonus || !entityLabor.default_accts.socialsec)
      throw new Error('Missing required default accounts for bonus and social security calculation');
  } catch (error) {
    throw new Error(`Error occured in [checkEntityLaborCalcs]: ${error}`);
  }
}

const resetGLAccountAndLockStatus = async (
  entityId: string,
  planId: string,
  versionId: string,
  div: string,
  dept: string,
  acct: string,
  acctFormatString: string[],
  positionTrigger: 'added' | 'removed'
) => {
  const fullAccount = utils.buildFullAccountString(acctFormatString, {
    div: div,
    dept: dept,
    acct: acct,
  });

  const laborPositionCollection = db.collection(`entities/${entityId}/labor/${versionId}/positions`);
  const versionAccountDoc = db.doc(`entities/${entityId}/plans/${planId}/versions/${versionId}/dept/${fullAccount}`);

  // calc_flag
  if (positionTrigger === 'added') {
    console.log(`[resetGLAccountAndLockStatus] locking account ${fullAccount} and checking if values need to be reset`);
    await versionAccountDoc.update({ is_locked: true, calc_type: 'labor' });

    // see if we have other positions on this account
    const posQuerySnap = await laborPositionCollection.where('acct', '==', acct).where('dept', '==', dept).get();

    if (posQuerySnap.empty) {
      console.log(`[resetGLAccountAndLockStatus] first position for account ${fullAccount}. Resetting values to zero`);
      await rollupRecalc.beginVersionRollupRecalc(
        {
          entity_id: entityId,
          plan_id: planId,
          version_id: versionId,
          dept: dept,
          acct_id: fullAccount,
          values: utils.getValuesArray(),
        },
        false,
        'entry'
      );
    }
  } else if (positionTrigger === 'removed') {
    console.log(`[resetGLAccountAndLockStatus] checking if account ${fullAccount} needs to be unlocked`);

    const posQuerySnap = await laborPositionCollection.where('acct', '==', acct).where('dept', '==', dept).get();

    if(posQuerySnap.docs.length === 1) { // we are deleting the last position for this account
      await versionAccountDoc.update({ is_locked: false}); 
      
      // also reset the calc_typ; TODO: move to expense  caslc
      setTimeout(async () => {
        await versionAccountDoc.update({ calc_type: 'entry'}); 
        console.log(`[resetGLAccountAndLockStatus] updated calc_type`);
      }, 5000)
    }
  }
  console.log(`[resetGLAccountAndLockStatus] complete`);

};
