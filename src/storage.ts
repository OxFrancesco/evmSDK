import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Context, Effect, Layer, Schema } from 'effect'
import { EvmError, Operation, WorkspaceEntry } from './model'

interface DocumentChange { readonly key: string; readonly expected: Schema.Json; readonly value: Schema.Json }

export class Store extends Context.Service<Store, {
  readonly commitDocuments: (changes: ReadonlyArray<DocumentChange>) => Effect.Effect<void, EvmError>
  readonly document: (key: string) => Effect.Effect<Schema.Json | null, EvmError>
  readonly putDocument: (key: string, value: Schema.Json) => Effect.Effect<void, EvmError>
  readonly documents: (prefix: string) => Effect.Effect<ReadonlyArray<Schema.Json>, EvmError>
  readonly updateDocument: (key: string, update: (value: Schema.Json | null) => Schema.Json) => Effect.Effect<Schema.Json, EvmError>
  readonly get: (id: string) => Effect.Effect<Operation, EvmError>
  readonly insert: (operation: Operation) => Effect.Effect<Operation, EvmError>
  readonly save: (operation: Operation) => Effect.Effect<void, EvmError>
  readonly list: () => Effect.Effect<ReadonlyArray<Operation>, EvmError>
  readonly lock: (operation: Operation) => Effect.Effect<void, EvmError>
  readonly unlock: (operation: Operation) => Effect.Effect<void, EvmError>
  readonly entries: () => Effect.Effect<ReadonlyArray<WorkspaceEntry>, EvmError>
  readonly putEntry: (entry: WorkspaceEntry) => Effect.Effect<void, EvmError>
  readonly removeEntry: (name: string) => Effect.Effect<void, EvmError>
}>()('@beegreat/evm/Store') {}

const decodeOperation = Schema.decodeUnknownSync(Schema.fromJsonString(Operation))
const decodeEntry = Schema.decodeUnknownSync(Schema.fromJsonString(WorkspaceEntry))

export function storeLayer(path: string) {
  return Layer.effect(Store, Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(Effect.try({
      try: () => {
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        const connection = new Database(path, { create: true, strict: true })
        if (path !== ':memory:') chmodSync(path, 0o600)
        connection.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
        connection.exec('CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS locks (account TEXT PRIMARY KEY, operation TEXT NOT NULL, pid INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS workspace (name TEXT PRIMARY KEY, body TEXT NOT NULL);')
        connection.exec('CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, body TEXT NOT NULL);')
        return connection
      },
      catch: () => new EvmError({ code: 'StorageError', message: 'Cannot open execution database.', retryable: false }),
    }), db => Effect.sync(() => db.close()))
    const action = <A>(run: () => A) => Effect.try({ try: run, catch: error => error instanceof EvmError ? error : new EvmError({ code: 'StorageError', message: 'Execution database operation failed. Preserve the database and inspect it before retrying.', retryable: false }) })
    const get = (id: string) => {
      const row = db.query<{ body: string }, [string]>('SELECT body FROM operations WHERE id = ?').get(id)
      if (!row) throw new EvmError({ code: 'NotFound', message: `Operation ${id} does not exist.`, retryable: false })
      return decodeOperation(row.body)
    }
    return Store.of({
      commitDocuments: Effect.fn('Store.commitDocuments')(changes => action(() => db.transaction(() => {
        for (const change of changes) {
          const row = db.query<{ body: string }, [string]>('SELECT body FROM documents WHERE id = ?').get(change.key)
          if ((row?.body ?? 'null') !== JSON.stringify(change.expected)) throw new EvmError({ code: 'AccountBusy', message: 'Document changed concurrently. Read its current state before retrying.', retryable: true })
        }
        for (const change of changes) db.query('INSERT INTO documents (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(change.key, JSON.stringify(change.value))
      }).immediate())),
      document: Effect.fn('Store.document')(key => action(() => {
        const row = db.query<{ body: string }, [string]>('SELECT body FROM documents WHERE id = ?').get(key)
        return row ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(row.body) : null
      })),
      putDocument: Effect.fn('Store.putDocument')((key, value) => action(() => {
        db.query('INSERT INTO documents (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(value))
      })),
      documents: Effect.fn('Store.documents')(prefix => action(() => db.query<{ body: string }, [string]>('SELECT body FROM documents WHERE substr(id, 1, length(?1)) = ?1 ORDER BY id').all(prefix).map(row => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(row.body)))),
      updateDocument: Effect.fn('Store.updateDocument')((key, update) => action(() => db.transaction(() => {
        const row = db.query<{ body: string }, [string]>('SELECT body FROM documents WHERE id = ?').get(key)
        const next = update(row ? Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(row.body) : null)
        db.query('INSERT INTO documents (id, body) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(next))
        return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(next))
      }).immediate())),
      get: Effect.fn('Store.get')(id => action(() => get(id))),
      insert: Effect.fn('Store.insert')(operation => action(() => db.transaction(() => {
        const row = db.query<{ body: string }, [string]>('SELECT body FROM operations WHERE id = ?').get(operation.plan.id)
        if (row) {
          const existing = decodeOperation(row.body)
          if (existing.plan.intentHash !== operation.plan.intentHash) throw new EvmError({ code: 'IdempotencyConflict', message: 'This key already belongs to a different transaction. Use a new key for a different action.', retryable: false })
          return existing
        }
        db.query('INSERT INTO operations (id, body) VALUES (?, ?)').run(operation.plan.id, JSON.stringify(operation))
        return operation
      }).immediate())),
      save: Effect.fn('Store.save')(operation => action(() => {
        db.query('UPDATE operations SET body = ? WHERE id = ?').run(JSON.stringify(operation), operation.plan.id)
      })),
      list: Effect.fn('Store.list')(() => action(() => db.query<{ body: string }, []>('SELECT body FROM operations ORDER BY rowid DESC LIMIT 100').all().map(row => decodeOperation(row.body)))),
      lock: Effect.fn('Store.lock')(operation => action(() => db.transaction(() => {
        const account = `${operation.plan.chainId}:${operation.plan.account.toLowerCase()}`
        const prior = db.query<{ pid: number }, [string]>('SELECT pid FROM locks WHERE account = ?').get(account)
        if (prior) {
          try { process.kill(prior.pid, 0) }
          catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ESRCH') db.query('DELETE FROM locks WHERE account = ?').run(account)
          }
        }
        const unresolved = db.query<{ id: string }, [number, string, string, string]>("SELECT id FROM operations WHERE json_extract(body, '$.plan.chainId') = ? AND lower(json_extract(body, '$.plan.account')) = ? AND id != ? AND id != ? AND json_extract(body, '$.state._tag') IN ('submitting', 'pending', 'walletPending') LIMIT 1").get(operation.plan.chainId, operation.plan.account.toLowerCase(), operation.plan.id, operation.plan.replacement?.id ?? '')
        if (unresolved) throw new EvmError({ code: 'AccountBusy', message: `Reconcile operation ${unresolved.id} before submitting another transaction from this account.`, retryable: false })
        const result = db.query('INSERT OR IGNORE INTO locks (account, operation, pid) VALUES (?, ?, ?)').run(account, operation.plan.id, process.pid)
        if (!result.changes) throw new EvmError({ code: 'AccountBusy', message: 'This account has an active execution in this database. Inspect its operation before submitting another.', retryable: false })
      }).immediate())),
      unlock: Effect.fn('Store.unlock')(operation => action(() => {
        db.query('DELETE FROM locks WHERE operation = ?').run(operation.plan.id)
      })),
      entries: Effect.fn('Store.entries')(() => action(() => db.query<{ body: string }, []>('SELECT body FROM workspace ORDER BY name').all().map(row => decodeEntry(row.body)))),
      putEntry: Effect.fn('Store.putEntry')(entry => action(() => { db.query('INSERT INTO workspace (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body').run(entry.name, JSON.stringify(entry)) })),
      removeEntry: Effect.fn('Store.removeEntry')(name => action(() => { db.query('DELETE FROM workspace WHERE name = ?').run(name) })),
    })
  }))
}
