import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, pad, type Address } from 'viem'
import {
  ABI_TYPE,
  encodeRoleKey,
  flattenScopeConditions,
  keeperPermissionCalls,
  OPERATOR,
  predictRolesModifierAddress,
  rolesAbi,
  wrapWithRole,
  type ConditionFlat,
  type RoleConfigCall,
} from './roles'

const SAFE: Address = '0x1000000000000000000000000000000000000001'
const NFPM: Address = '0x2000000000000000000000000000000000000002'
const GAUGE_A: Address = '0x3000000000000000000000000000000000000003'
const GAUGE_B: Address = '0x4000000000000000000000000000000000000004'
const SWAPPER: Address = '0x5000000000000000000000000000000000000005'
const PERMIT2: Address = '0x6000000000000000000000000000000000000006'
const WETH: Address = '0x7000000000000000000000000000000000000007'
const USDC: Address = '0x8000000000000000000000000000000000000008'

/** Mirrors the Integrity.sol rules our trees must satisfy on-chain. */
function assertIntegrity(conditions: ConditionFlat[]): void {
  expect(conditions.length).toBeGreaterThan(0)
  expect(conditions[0]).toMatchObject({ parent: 0, paramType: ABI_TYPE.Calldata, operator: OPERATOR.Matches })
  expect(conditions.filter((node, index) => node.parent === index)).toHaveLength(1)
  for (let i = 1; i < conditions.length; i++) {
    expect(conditions[i - 1].parent).toBeLessThanOrEqual(conditions[i].parent)
    expect(conditions[i].parent).toBeLessThan(i)
  }
  const childCount = (index: number) => conditions.filter((node, i) => i !== 0 && node.parent === index).length
  conditions.forEach((node, index) => {
    if (node.paramType === ABI_TYPE.Static || node.paramType === ABI_TYPE.Dynamic) expect(childCount(index)).toBe(0)
    if (node.paramType === ABI_TYPE.Tuple || node.paramType === ABI_TYPE.Calldata) expect(childCount(index)).toBeGreaterThan(0)
    if (node.operator === OPERATOR.Or) expect(childCount(index)).toBeGreaterThan(0)
    if (node.operator === OPERATOR.EqualTo) expect(node.compValue.length).toBe(2 + 64)
    if (node.operator !== OPERATOR.EqualTo) expect(node.compValue).toBe('0x')
  })
}

describe('encodeRoleKey', () => {
  test('utf8 right-pads to bytes32', () => {
    expect(encodeRoleKey('aero-alm')).toBe('0x6165726f2d616c6d000000000000000000000000000000000000000000000000')
    expect(() => encodeRoleKey('x'.repeat(33))).toThrow('32 bytes')
  })
})

describe('flattenScopeConditions', () => {
  test('single pinned address param', () => {
    const conditions = flattenScopeConditions([{ kind: 'one-of-addresses', addresses: [GAUGE_A] }, { kind: 'pass' }])
    assertIntegrity(conditions)
    expect(conditions).toHaveLength(3)
    expect(conditions[1]).toMatchObject({ parent: 0, paramType: ABI_TYPE.Static, operator: OPERATOR.EqualTo, compValue: pad(GAUGE_A, { size: 32 }) })
    expect(conditions[2]).toMatchObject({ parent: 0, paramType: ABI_TYPE.Static, operator: OPERATOR.Pass })
  })

  test('or-set over addresses expands to an Or node with EqualTo children in BFS order', () => {
    const conditions = flattenScopeConditions([
      { kind: 'one-of-addresses', addresses: [GAUGE_A, GAUGE_B] },
      { kind: 'pass' },
    ])
    assertIntegrity(conditions)
    expect(conditions[1]).toMatchObject({ parent: 0, paramType: ABI_TYPE.None, operator: OPERATOR.Or })
    expect(conditions[2]).toMatchObject({ parent: 0, operator: OPERATOR.Pass })
    expect(conditions[3]).toMatchObject({ parent: 1, operator: OPERATOR.EqualTo, compValue: pad(GAUGE_A, { size: 32 }) })
    expect(conditions[4]).toMatchObject({ parent: 1, operator: OPERATOR.EqualTo, compValue: pad(GAUGE_B, { size: 32 }) })
  })

  test('tuple params pin nested fields (collect recipient == avatar)', () => {
    const conditions = flattenScopeConditions([
      { kind: 'tuple', fields: [{ kind: 'pass' }, { kind: 'equal-to-avatar' }, { kind: 'pass' }, { kind: 'pass' }] },
    ])
    assertIntegrity(conditions)
    expect(conditions[1]).toMatchObject({ parent: 0, paramType: ABI_TYPE.Tuple, operator: OPERATOR.Matches })
    expect(conditions[3]).toMatchObject({ parent: 1, paramType: ABI_TYPE.Static, operator: OPERATOR.EqualToAvatar })
  })
})

describe('keeperPermissionCalls', () => {
  const calls = keeperPermissionCalls(
    { nfpm: NFPM, gauges: [GAUGE_A, GAUGE_B, GAUGE_A], swapper: SWAPPER, permit2: PERMIT2, tokens: [WETH, USDC, WETH] },
    encodeRoleKey('aero-alm'),
  )
  const scopeFunctions = calls.filter((call) => call.functionName === 'scopeFunction')
  // SAFETY: keeperPermissionCalls builds scopeFunction args with the
  // ConditionFlat array at index 3, matching the rolesAbi entry.
  const conditionsOf = (call: RoleConfigCall) => call.args[3] as ConditionFlat[]

  test('scopes every target exactly once (gauges and tokens deduped)', () => {
    const targets = calls.filter((call) => call.functionName === 'scopeTarget').map((call) => String(call.args[1]).toLowerCase())
    expect(new Set(targets).size).toBe(targets.length)
    expect(targets).toHaveLength(5) // nfpm, swapper, permit2, 2 gauges, 2 tokens
  })

  test('every condition tree satisfies the Integrity rules', () => {
    for (const call of scopeFunctions) assertIntegrity(conditionsOf(call))
  })

  test('mint and collect pin the recipient to the avatar', () => {
    for (const call of scopeFunctions.filter((c) => c.args[1] === NFPM)) {
      const conditions = conditionsOf(call)
      const hasTuple = conditions.some((node) => node.paramType === ABI_TYPE.Tuple)
      if (hasTuple) expect(conditions.some((node) => node.operator === OPERATOR.EqualToAvatar)).toBe(true)
    }
    expect(scopeFunctions.filter((c) => c.args[1] === NFPM && conditionsOf(c).some((n) => n.operator === OPERATOR.EqualToAvatar))).toHaveLength(2)
  })

  test('the NFT can only be approved to the managed gauges', () => {
    const approve = scopeFunctions.find((call) => call.args[1] === NFPM && conditionsOf(call).some((node) => node.operator === OPERATOR.Or || (node.operator === OPERATOR.EqualTo)))
    expect(approve).toBeDefined()
    const compValues = conditionsOf(approve!).filter((node) => node.operator === OPERATOR.EqualTo).map((node) => node.compValue.toLowerCase())
    expect(compValues).toEqual([pad(GAUGE_A, { size: 32 }), pad(GAUGE_B, { size: 32 })].map((value) => value.toLowerCase()))
  })

  test('ERC20 approvals are pinned to the NFPM only', () => {
    for (const token of [WETH, USDC]) {
      const call = scopeFunctions.find((c) => String(c.args[1]).toLowerCase() === token.toLowerCase())
      expect(call).toBeDefined()
      const spenders = conditionsOf(call!).filter((node) => node.operator === OPERATOR.EqualTo).map((node) => node.compValue.toLowerCase())
      expect(spenders).toEqual([pad(NFPM, { size: 32 }).toLowerCase()])
    }
  })

  test('does not grant swapper or Permit2 permissions', () => {
    expect(calls.some((call) => call.args[1] === SWAPPER || call.args[1] === PERMIT2)).toBe(false)
  })

  test('no permission ever allows ether or delegatecall (ExecutionOptions.None)', () => {
    for (const call of calls.filter((c) => c.functionName !== 'scopeTarget')) {
      expect(call.args.at(-1)).toBe(0)
    }
  })
})

describe('wrapWithRole', () => {
  const KEEPER: Address = '0x9000000000000000000000000000000000000009'
  const MODIFIER: Address = '0xa00000000000000000000000000000000000000a'

  test('wraps a plan step into execTransactionWithRole', () => {
    const wrapped = wrapWithRole({ from: SAFE, to: NFPM, data: '0xdeadbeef', value: 0n }, KEEPER, MODIFIER, encodeRoleKey('aero-alm'))
    expect(wrapped.from).toBe(KEEPER)
    expect(wrapped.to).toBe(MODIFIER)
    expect(wrapped.value).toBe(0n)
    const decoded = decodeFunctionData({ abi: rolesAbi, data: wrapped.data })
    expect(decoded.functionName).toBe('execTransactionWithRole')
    expect(decoded.args).toEqual([NFPM, 0n, '0xdeadbeef', 0, encodeRoleKey('aero-alm'), true])
  })

  test('refuses plans that carry ether', () => {
    expect(() => wrapWithRole({ from: SAFE, to: NFPM, data: '0x', value: 1n }, KEEPER, MODIFIER, encodeRoleKey('aero-alm')))
      .toThrow('must not send ether')
  })
})

describe('predictRolesModifierAddress', () => {
  test('is deterministic and salt-sensitive', () => {
    const first = predictRolesModifierAddress(SAFE, 0n)
    expect(predictRolesModifierAddress(SAFE, 0n)).toBe(first)
    expect(predictRolesModifierAddress(SAFE, 1n)).not.toBe(first)
    expect(predictRolesModifierAddress('0x2000000000000000000000000000000000000002', 0n)).not.toBe(first)
    expect(first).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})
