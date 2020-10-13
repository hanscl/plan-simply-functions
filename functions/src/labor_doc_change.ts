// import * as functions from "firebase-functions";
// import * as admin from "firebase-admin";
// import * as labor_model from "./labor_model";
// import * as plan_model from "./plan_model";
// import * as utils from "./utils";
// import * as entity_model from "./entity_model";
// import * as version_recalc from "./version_rollup_recalc_master";

// const db = admin.firestore();

// interface contextParams {
//   entity_id: string;
//   position_id: string;
//   plan_id?: string;
//   version_id: string;
// }

// export const laborPosDocCreate = functions.firestore
//   .document("entities/{entityId}/labor/{versionId}/positions/{positionId}")
//   .onCreate(async (snapshot, context) => {
//     try {
//     } catch (error) {
        
//       console.log(`Error occured during onCreate Trigger for labor position: ${error}`);
//     }
//   });



//   export const laborPosDocDelete = functions.firestore
//   .document("entities/{entityId}/labor/{versionId}/positions/{positionId}")
//   .onDelete(async (snapshot, context) => {
//     try {
//     } catch (error) {
//       console.log(`Error occured during onDelete Trigger for labor position: ${error}`);
//     }
//   });
