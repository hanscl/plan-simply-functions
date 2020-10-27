import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as entity_model from "./entity_model";

const db = admin.firestore();

interface EntityChild {
  id: string;
  name: string;
  type: string;
  entityChildren?: EntityChild[];
  divDeptChildren: entity_model.hierLevel[];
}

// interface DivDeptChild {
//   id: string;
//   level: string;
//   name: string;
//   children?: DivDeptChild[];
// }

interface EntityList {
  id: string;
  doc: entity_model.entityDoc;
}

// TODO: This needs to be also triggered on new entity create
export const buildCompanyHierarchy = functions.firestore.document("entities/{entityId}/entity_structure/hier").onWrite(async (snapshot, context) => {
  try {
    const allEntitiesHier: EntityChild[] = [];
    const entSnap = await db.collection("entities").get();
    const allEnts: EntityList[] = [];
    for (const entDoc of entSnap.docs) {
      allEnts.push({ id: entDoc.id, doc: entDoc.data() as entity_model.entityDoc });
    }
    for (let outer = 0; outer < allEnts.length; outer++) {
      let isTopLevelEntity = true;
      for (let inner = 0; inner < allEnts.length; inner++) {
        if (inner === outer) continue;
        if (allEnts[inner].doc.children !== undefined && allEnts[inner].doc.children?.includes(allEnts[outer].id)) isTopLevelEntity = false;
      }
      if (isTopLevelEntity) {
        allEntitiesHier.push({ id: allEnts[outer].id, name: allEnts[outer].doc.name, type: allEnts[outer].doc.type, divDeptChildren: [] });
      }
    }

    for (const topLevelParent of allEntitiesHier) {
      await addChildren(topLevelParent, allEnts);
    }

    await db.doc(`company_structure/hier`).set({children: allEntitiesHier});

    console.log(`Top-level entities only: ${JSON.stringify(allEntitiesHier)}`);
  } catch (error) {
    console.log(`Error occured while building company hierarchy: ${error}`);
    return;
  }
});

async function addChildren(parentEntity: EntityChild, allEnts: EntityList[]) {
  try {
  // add divdept hierarchy
  const hierDoc = await db.doc(`entities/${parentEntity.id}/entity_structure/hier`).get();
  if(!hierDoc.exists) throw new Error(`Could not find hierDoc`);
  const hierData = hierDoc.data() as entity_model.hierDoc;
  //parentEntity.divDeptChildren = [];
  console.log(`hierData: ${JSON.stringify(hierData)}`);
  for (const hierLevel of hierData.children) {
    parentEntity.divDeptChildren.push(hierLevel);
  }
  const fltrdEntList = allEnts.filter((entity) => {
    return entity.id === parentEntity.id;
  });
  console.log(`fltrdEntList: ${JSON.stringify(fltrdEntList)}`);
  if (fltrdEntList.length > 0 && fltrdEntList[0].doc.children) {
    parentEntity.entityChildren = [];
    for (const childId of fltrdEntList[0].doc.children) {
      const childEntArr = allEnts.filter((entity) => {
        return entity.id === childId;
      });
      console.log(`childEntArr: ${JSON.stringify(childEntArr)}`);
      if (childEntArr.length > 0) {
        parentEntity.entityChildren.push({ id: childId, name: childEntArr[0].doc.name, type: childEntArr[0].doc.type, divDeptChildren: [] });
        await addChildren(parentEntity.entityChildren[parentEntity.entityChildren.length - 1], allEnts);
      }
    }
  }
  }
catch(error) {
  throw new Error(`Error during addChildren: ${error}`);
}
}