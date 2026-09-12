import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteIndex, listIndices, readIndex, saveIndex } from './indices'

test('index persistence supports create, update, reload and delete without overwriting another index', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aero-indices-'))
  const previous = process.env.AERO_INDEX_DIR
  process.env.AERO_INDEX_DIR = directory
  try {
    expect(listIndices()).toEqual([])
    saveIndex('tech', 'NVDA=50,AAPL=50')
    expect(readIndex('tech').allocations).toBe('NVDAc=50,AAPLc=50')
    expect(() => saveIndex('tech', 'NVDA=100')).toThrow()
    expect(() => saveIndex('../unsafe', 'NVDA=100')).toThrow()
    saveIndex('tech', 'NVDA=0,AAPL=100', true)
    expect(listIndices()).toEqual([{ name: 'tech', allocations: 'NVDAc=0,AAPLc=100' }])
    writeFileSync(join(directory, 'broken.json'), '{"name":"broken","allocations":"NVDA=5"}')
    expect(() => readIndex('broken')).toThrow('100%')
    deleteIndex('broken')
    deleteIndex('tech')
    expect(listIndices()).toEqual([])
  } finally {
    if (previous === undefined) delete process.env.AERO_INDEX_DIR
    else process.env.AERO_INDEX_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
