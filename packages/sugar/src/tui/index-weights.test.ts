import { expect, test } from 'bun:test'
import { parseAllocations } from '../stocks/catalog'
import { equalWeights, indexAllocations } from './index-weights'

test('equal weights preserve exits and distribute rounding to exactly 100 percent', () => {
  const weights = equalWeights(new Map([['NVDAc', 0], ['AAPLc', 1], ['GOOGLc', 1], ['METAc', 1]]))
  expect([...weights.values()]).toEqual([0, 3334, 3333, 3333])
  expect(parseAllocations(indexAllocations(weights))).toHaveLength(4)
  expect(() => equalWeights(new Map([['NVDAc', 0]]))).toThrow('Choose stocks')
})

test('removing a saved constituent keeps its zero percent exit target', () => {
  expect(indexAllocations(new Map([['AAPLc', 10000]]), 'NVDAc=50,AAPLc=50')).toBe('NVDAc=0,AAPLc=100')
  expect(indexAllocations(new Map([['AAPLc', 10000]]))).toBe('AAPLc=100')
})
