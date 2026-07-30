import type { AepPublicDocumentCache } from '@aep-foundation/agent';
import {
  createAepPublicDocumentCache,
  type AuthStorage,
  type PublicDocumentStateStorage,
} from '@inflowpayai/inflow-core';

export function persistedAepPublicDocumentCache(storage: AuthStorage): AepPublicDocumentCache | undefined {
  if (!hasDocumentStorage(storage)) return undefined;
  return createAepPublicDocumentCache(storage as AuthStorage & PublicDocumentStateStorage);
}

function hasDocumentStorage(storage: AuthStorage): boolean {
  return (
    'getDiscoveryDocuments' in storage &&
    'setDiscoveryDocuments' in storage &&
    'getOpenApiDocuments' in storage &&
    'setOpenApiDocuments' in storage
  );
}
