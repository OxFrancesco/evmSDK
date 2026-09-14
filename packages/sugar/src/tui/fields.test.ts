import { describe, expect, test } from 'bun:test'
import { ACTION_SCHEMA, requestParameters } from '../action-schema'
import { SUGAR_ACTIONS } from '../contracts'
import { validateSugarRequest } from '../index'
import { actionFields, buildParameters, initialValues, MORE_OPTIONS, POOL_IS_CL, visibleFields } from './fields'

const names = (fields: { name: string }[]) => fields.map((field) => field.name)

describe('action schema', () => {
  test('every action lists each parameter once and never the context parameters', () => {
    for (const action of SUGAR_ACTIONS) {
      const listed = names([...ACTION_SCHEMA[action].parameters])
      expect(new Set(listed).size).toBe(listed.length)
      expect(listed).not.toContain('chain')
      expect(listed).not.toContain('wallet')
    }
  })

  test('the validator accepts exactly the schema parameters', () => {
    const wallet = '0x1111111111111111111111111111111111111111'
    expect(names(requestParameters('withdraw'))).toEqual(['chain', 'wallet', 'pool', 'position', 'fraction', 'burn', 'collect', 'unwrap_native', 'slippage', 'deadline_minutes'])
    expect(() => validateSugarRequest('withdraw', { chain: 8453, wallet, pool: wallet, tick_lower: 1 })).toThrow('Unsupported parameter for withdraw: tick_lower')
    expect(() => validateSugarRequest('pools', { chain: 8453, pool_type: 'weird' })).toThrow('pool_type must be cl, stable, or volatile')
    expect(() => validateSugarRequest('pools', { chain: 8453, limit: 2.5 })).toThrow('limit must be an integer')
  })
})

describe('TUI form projection', () => {
  test('deposit hides new-pool rows once a pool is chosen and CL rows until the pool is CL', () => {
    const fields = actionFields('deposit')
    const values = initialValues(fields)
    expect(names(visibleFields(fields, values))).toEqual(['pool', 'token0', 'token1', 'pool_type', 'amount0', 'amount1', 'use_decimals', MORE_OPTIONS])
    expect(names(visibleFields(fields, { ...values, pool_type: 'cl' }))).toContain('tick_spacing')
    const picked = { ...values, pool: '0x2222222222222222222222222222222222222222', [POOL_IS_CL]: true }
    const shown = names(visibleFields(fields, picked))
    expect(shown).not.toContain('token0')
    expect(shown).not.toContain('tick_spacing')
    expect(shown).toContain('price_lower')
    expect(names(visibleFields(fields, { ...values, [MORE_OPTIONS]: true }))).toContain('slippage')
  })

  test('hidden rows never reach the parameters and the toggle is never sent', () => {
    const fields = actionFields('deposit')
    const values = { ...initialValues(fields), pool: '0x2222222222222222222222222222222222222222', tick_spacing: '100', amount0: '1' }
    expect(buildParameters(visibleFields(fields, values), values, 8453)).toEqual({ chain: 8453, pool: '0x2222222222222222222222222222222222222222', amount0: '1', use_decimals: true })
  })

  test('booleans the action defaults to on start on and send an explicit false when turned off', () => {
    const fields = actionFields('withdraw')
    const values = initialValues(fields)
    expect(values.collect).toBe(true)
    const off = { ...values, collect: false, pool: '0x2222222222222222222222222222222222222222' }
    expect(buildParameters(visibleFields(fields, off), off, 8453).collect).toBe(false)
  })
})
