import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as Predicate from 'effect/Predicate'
import { formatAllocations, parseAllocations } from './catalog'

export type StockIndex = { name: string; allocations: string }
const directory = () => process.env.AERO_INDEX_DIR ?? join(homedir(), '.config', 'aero', 'indices')

function indexPath(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('Index name must be 1-64 letters, numbers, hyphens, or underscores')
  return join(directory(), `${name}.json`)
}

export function saveIndex(name: string, allocations: string, replace = false): StockIndex {
  const path = indexPath(name)
  const index = { name, allocations: formatAllocations(parseAllocations(allocations)) }
  mkdirSync(directory(), { recursive: true, mode: 0o700 })
  if (!replace) writeFileSync(path, JSON.stringify(index, null, 2), { flag: 'wx', mode: 0o600 })
  else {
    readIndex(name)
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(index, null, 2), { flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  }
  return index
}

export function readIndex(name: string): StockIndex {
  const data: unknown = JSON.parse(readFileSync(indexPath(name), 'utf8'))
  if (!Predicate.isObject(data) || !('name' in data) || !('allocations' in data) || data.name !== name || !Predicate.isString(data.allocations)) throw new Error(`Invalid index file for ${name}`)
  return { name, allocations: formatAllocations(parseAllocations(data.allocations)) }
}

export function listIndices(): StockIndex[] {
  mkdirSync(directory(), { recursive: true, mode: 0o700 })
  return readdirSync(directory()).filter((file) => file.endsWith('.json')).sort().map((file) => readIndex(file.slice(0, -5)))
}

export function deleteIndex(name: string): void {
  unlinkSync(indexPath(name))
}
