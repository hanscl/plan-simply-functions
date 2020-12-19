import * as admin from 'firebase-admin';
import { EntityRollupDocument } from '../entity_model';

const db = admin.firestore();

interface AccountNode {
  level: 'pnl' | 'div' | 'dept';
  accountId: string;
  dependentNodes: AccountNode[];
  parentNodes: AccountNode[];
  accountChildren: string[];
}

export const versionFullCalc = async () => {};

const buildRollupHierarchy = async (entityId: string, planId: string, versionId: string) => {
  const accountCalculationTree: AccountNode[] = [];
  // query rollups ordered by level
  const rollupQuerySnapshot = await db.collection(`entities/${entityId}/entity_structure/rollup/rollups`).get();

  for (const rollupDocument of rollupQuerySnapshot.docs) {
    const rollupDefinition = rollupDocument.data() as EntityRollupDocument;
  }
};
