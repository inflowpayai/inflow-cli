import { SecureSqliteRepository } from '../secure-storage/sqlite.js';

export interface PublicSourceCache {
  delete(kind: 'document' | 'location', url: string): void;
  get(kind: 'document' | 'location', url: string): unknown;
  set(kind: 'document' | 'location', url: string, value: unknown): void;
}

export class SqlitePublicSourceCache implements PublicSourceCache {
  constructor(private readonly databasePath?: string) {}

  delete(kind: 'document' | 'location', url: string): void {
    this.withRepository((repository) => repository.deletePublicDocument(namespace(kind), url));
  }

  get(kind: 'document' | 'location', url: string): unknown {
    return this.withRepository((repository) => repository.getPublicDocument(namespace(kind), url)?.payload);
  }

  set(kind: 'document' | 'location', url: string, value: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    this.withRepository((repository) => {
      repository.deletePublicDocument(namespace(kind), url);
      if (bytes > 4 * 1024 * 1024) return;
      repository.upsertPublicDocument({
        namespace: namespace(kind),
        url,
        payload: value,
        cachedAt: new Date().toISOString(),
      });
      const records = repository
        .listPublicDocuments(namespace(kind))
        .sort((a, b) => b.cachedAt.localeCompare(a.cachedAt));
      let total = 0;
      records.forEach((record, index) => {
        total += Buffer.byteLength(JSON.stringify(record.payload));
        if (index >= 128 || total > 32 * 1024 * 1024) repository.deletePublicDocument(record.namespace, record.url);
      });
    });
  }

  private withRepository<T>(work: (repository: SecureSqliteRepository) => T): T {
    const repository = new SecureSqliteRepository(
      this.databasePath === undefined ? {} : { databasePath: this.databasePath },
    );
    try {
      repository.initialize();
      return work(repository);
    } finally {
      repository.close();
    }
  }
}

function namespace(kind: 'document' | 'location'): 'source-document' | 'source-location' {
  return kind === 'document' ? 'source-document' : 'source-location';
}
