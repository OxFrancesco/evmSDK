import {
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  keccak256,
  encodePacked,
  pad,
  stringToHex,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { normalizeAddress } from '../helpers'
import type { UnsignedTransaction } from '../types'

/**
 * Zodiac Roles Modifier v2 encoding for the ALM's Safe mode.
 *
 * In Safe mode the positions live in a Safe and a low-privilege keeper key
 * executes rebalances through a Roles Modifier attached to it. The role is
 * scoped so the keeper can ONLY perform the rebalance moves — recipients are
 * pinned to the Safe (EqualToAvatar), NFT approvals are pinned to the pool
 * gauges, and ERC20 approvals are pinned to the NFPM/Permit2. A compromised
 * keeper cannot move funds anywhere else.
 *
 * Contract source: resources/zodiac-roles (v2.1.0). Both singletons below
 * are deterministic-deployment addresses, verified live on Base.
 */

/** Roles v2.1.0 mastercopy (packages/evm/mastercopies.json). */
export const ROLES_V2_MASTERCOPY: Address = '0x9646fDAD06d3e24444381f44362a3B0eB343D337'
/** Zodiac ModuleProxyFactory (canonical deterministic deployment). */
export const MODULE_PROXY_FACTORY: Address = '0x000000000000aDdB49795b0f9bA5BC298cDda236'

/** Types.sol enums (only the members used here). */
export const ABI_TYPE = { None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, Calldata: 5 } as const
export const OPERATOR = { Pass: 0, Or: 2, Matches: 5, EqualToAvatar: 15, EqualTo: 16 } as const
export const EXECUTION_OPTIONS = { None: 0, Send: 1, DelegateCall: 2, Both: 3 } as const

export type ConditionFlat = { parent: number; paramType: number; operator: number; compValue: Hex }

export const rolesAbi = [
  {
    type: 'function', name: 'setUp', stateMutability: 'nonpayable',
    inputs: [{ name: 'initParams', type: 'bytes' }], outputs: [],
  },
  {
    type: 'function', name: 'assignRoles', stateMutability: 'nonpayable',
    inputs: [
      { name: 'module', type: 'address' },
      { name: 'roleKeys', type: 'bytes32[]' },
      { name: 'memberOf', type: 'bool[]' },
    ], outputs: [],
  },
  {
    type: 'function', name: 'scopeTarget', stateMutability: 'nonpayable',
    inputs: [{ name: 'roleKey', type: 'bytes32' }, { name: 'targetAddress', type: 'address' }], outputs: [],
  },
  {
    type: 'function', name: 'allowFunction', stateMutability: 'nonpayable',
    inputs: [
      { name: 'roleKey', type: 'bytes32' },
      { name: 'targetAddress', type: 'address' },
      { name: 'selector', type: 'bytes4' },
      { name: 'options', type: 'uint8' },
    ], outputs: [],
  },
  {
    type: 'function', name: 'scopeFunction', stateMutability: 'nonpayable',
    inputs: [
      { name: 'roleKey', type: 'bytes32' },
      { name: 'targetAddress', type: 'address' },
      { name: 'selector', type: 'bytes4' },
      {
        name: 'conditions', type: 'tuple[]', components: [
          { name: 'parent', type: 'uint8' },
          { name: 'paramType', type: 'uint8' },
          { name: 'operator', type: 'uint8' },
          { name: 'compValue', type: 'bytes' },
        ],
      },
      { name: 'options', type: 'uint8' },
    ], outputs: [],
  },
  {
    type: 'function', name: 'execTransactionWithRole', stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'roleKey', type: 'bytes32' },
      { name: 'shouldRevert', type: 'bool' },
    ], outputs: [{ name: 'success', type: 'bool' }],
  },
] as const satisfies Abi

export const moduleProxyFactoryAbi = [
  {
    type: 'function', name: 'deployModule', stateMutability: 'nonpayable',
    inputs: [
      { name: 'masterCopy', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ], outputs: [{ name: 'proxy', type: 'address' }],
  },
] as const satisfies Abi

export const safeAbi = [
  {
    type: 'function', name: 'enableModule', stateMutability: 'nonpayable',
    inputs: [{ name: 'module', type: 'address' }], outputs: [],
  },
  {
    type: 'function', name: 'isModuleEnabled', stateMutability: 'view',
    inputs: [{ name: 'module', type: 'address' }], outputs: [{ name: '', type: 'bool' }],
  },
] as const satisfies Abi

/** Human role name -> bytes32 key (UTF-8, right-padded; max 32 bytes). */
export function encodeRoleKey(name: string): Hex {
  const hex = stringToHex(name)
  if ((hex.length - 2) / 2 > 32) throw new Error('role name exceeds 32 bytes')
  return pad(hex, { size: 32, dir: 'right' })
}

/** Roles.setUp initializer for a Safe that is owner, avatar, and target at once. */
export function rolesInitializer(safe: Address): Hex {
  return encodeFunctionData({
    abi: rolesAbi,
    functionName: 'setUp',
    args: [encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [safe, safe, safe])],
  })
}

/**
 * Predict the Roles proxy address deployed by
 * ModuleProxyFactory.deployModule(mastercopy, initializer, saltNonce).
 * Mirrors the factory: CREATE2 over the minimal-proxy bytecode with
 * salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce)).
 */
export function predictRolesModifierAddress(safe: Address, saltNonce: bigint): Address {
  const initializer = rolesInitializer(safe)
  const salt = keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(initializer), saltNonce]))
  const bytecode = `0x602d8060093d393df3363d3d373d3d3d363d73${ROLES_V2_MASTERCOPY.slice(2)}5af43d82803e903d91602b57fd5bf3` as const
  return getCreate2Address({ from: MODULE_PROXY_FACTORY, salt, bytecodeHash: keccak256(bytecode) })
}

// --- condition trees ---

export type ParamCondition =
  | { kind: 'pass'; abi?: 'static' | 'dynamic' }
  | { kind: 'equal-to-avatar' }
  | { kind: 'one-of-addresses'; addresses: Address[] }
  | { kind: 'tuple'; fields: ParamCondition[] }

/**
 * Flatten per-parameter conditions into the BFS-ordered ConditionFlat array
 * scopeFunction expects: a Calldata/Matches root whose children map
 * positionally onto the function parameters (Integrity.sol enforces the
 * BFS/root/child-count rules replicated here).
 */
export function flattenScopeConditions(params: ParamCondition[]): ConditionFlat[] {
  if (params.length === 0) throw new Error('scoped functions need at least one parameter condition')
  const nodes: ConditionFlat[] = [{ parent: 0, paramType: ABI_TYPE.Calldata, operator: OPERATOR.Matches, compValue: '0x' }]
  const queue: Array<{ condition: ParamCondition; parent: number }> = params.map((condition) => ({ condition, parent: 0 }))
  while (queue.length > 0) {
    const { condition, parent } = queue.shift()!
    const index = nodes.length
    switch (condition.kind) {
      case 'pass':
        nodes.push({ parent, paramType: condition.abi === 'dynamic' ? ABI_TYPE.Dynamic : ABI_TYPE.Static, operator: OPERATOR.Pass, compValue: '0x' })
        break
      case 'equal-to-avatar':
        nodes.push({ parent, paramType: ABI_TYPE.Static, operator: OPERATOR.EqualToAvatar, compValue: '0x' })
        break
      case 'one-of-addresses': {
        if (condition.addresses.length === 0) throw new Error('one-of-addresses needs at least one address')
        if (condition.addresses.length === 1) {
          nodes.push({ parent, paramType: ABI_TYPE.Static, operator: OPERATOR.EqualTo, compValue: pad(condition.addresses[0], { size: 32 }) })
          break
        }
        nodes.push({ parent, paramType: ABI_TYPE.None, operator: OPERATOR.Or, compValue: '0x' })
        for (const address of condition.addresses) {
          queue.push({ condition: { kind: 'one-of-addresses', addresses: [address] }, parent: index })
        }
        break
      }
      case 'tuple':
        nodes.push({ parent, paramType: ABI_TYPE.Tuple, operator: OPERATOR.Matches, compValue: '0x' })
        for (const field of condition.fields) queue.push({ condition: field, parent: index })
        break
    }
  }
  return nodes
}

// --- keeper permission set for the ALM role ---

export type KeeperPermissionInput = {
  /** Slipstream NonfungiblePositionManager. */
  nfpm: Address
  /** Gauges of every managed pool. */
  gauges: Address[]
  /** Universal-router-style swapper and its Permit2. */
  swapper: Address
  permit2: Address
  /** Every ERC20 the keeper may approve (pool legs + emissions token). */
  tokens: Address[]
}

export type RoleConfigCall = { functionName: 'scopeTarget' | 'allowFunction' | 'scopeFunction'; args: readonly unknown[] }

const passStatic: ParamCondition = { kind: 'pass' }

function scoped(target: Address, signature: string, params: ParamCondition[], roleKey: Hex): RoleConfigCall {
  return {
    functionName: 'scopeFunction',
    args: [roleKey, target, toFunctionSelector(signature), flattenScopeConditions(params), EXECUTION_OPTIONS.None],
  }
}

function allowed(target: Address, signature: string, roleKey: Hex): RoleConfigCall {
  return { functionName: 'allowFunction', args: [roleKey, target, toFunctionSelector(signature), EXECUTION_OPTIONS.None] }
}

/**
 * The full permission set for the ALM keeper role. Security invariants:
 * - mint/collect recipients are pinned to the avatar (the Safe)
 * - the position NFT can only ever be approved to a managed pool's gauge
 * - ERC20 approvals only to the NFPM or Permit2 (never to an EOA)
 * - Permit2 allowances only for the swapper as spender
 * - no ether sends, no delegatecalls, no arbitrary targets
 */
export function keeperPermissionCalls(input: KeeperPermissionInput, roleKey: Hex): RoleConfigCall[] {
  // normalizeAddress canonicalizes casing, so the Set dedupes reliably.
  const gauges = [...new Set(input.gauges.map(normalizeAddress))]
  const tokens = [...new Set(input.tokens.map(normalizeAddress))]
  const calls: RoleConfigCall[] = []
  const targets = [input.nfpm, ...gauges, ...tokens]
  for (const target of targets) {
    calls.push({ functionName: 'scopeTarget', args: [roleKey, target] })
  }
  // NFPM — the position lifecycle.
  calls.push(
    scoped(input.nfpm, 'mint((address,address,int24,int24,int24,uint256,uint256,uint256,uint256,address,uint256,uint160))', [
      { kind: 'tuple', fields: [passStatic, passStatic, passStatic, passStatic, passStatic, passStatic, passStatic, passStatic, passStatic, { kind: 'equal-to-avatar' }, passStatic, passStatic] },
    ], roleKey),
    scoped(input.nfpm, 'collect((uint256,address,uint128,uint128))', [
      { kind: 'tuple', fields: [passStatic, { kind: 'equal-to-avatar' }, passStatic, passStatic] },
    ], roleKey),
    allowed(input.nfpm, 'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))', roleKey),
    allowed(input.nfpm, 'burn(uint256)', roleKey),
    scoped(input.nfpm, 'approve(address,uint256)', [
      { kind: 'one-of-addresses', addresses: gauges },
      passStatic,
    ], roleKey),
  )
  // Gauges — stake, unstake, claim.
  for (const gauge of gauges) {
    calls.push(
      allowed(gauge, 'deposit(uint256)', roleKey),
      allowed(gauge, 'withdraw(uint256)', roleKey),
      allowed(gauge, 'getReward(uint256)', roleKey),
    )
  }
  // Swapper + Permit2 — swaps of the rebalance float.
  if (calls.some((call) => call.args[1] === input.swapper || call.args[1] === input.permit2)) {
    throw new Error('Swapper and Permit2 permissions are disabled for Safe ALM')
  }
  // ERC20 approvals — only ever to the NFPM or Permit2.
  for (const token of tokens) {
    calls.push(
      scoped(token, 'approve(address,uint256)', [
        { kind: 'one-of-addresses', addresses: [input.nfpm] },
        passStatic,
      ], roleKey),
    )
  }
  return calls
}

export function assertSafeAlmSupported(): void {
  throw new Error('Safe ALM execution and permission setup are disabled for 0.1 pending on-chain permission verification. Existing roles must be revoked by the Safe owners.')
}

export function encodeRoleConfigCall(rolesModifier: Address, call: RoleConfigCall) {
  assertSafeAlmSupported()
  // SAFETY: RoleConfigCall args are built above to match the corresponding
  // rolesAbi entry; viem cannot statically connect a dynamic functionName to
  // its argument tuple.
  const data = encodeFunctionData({ abi: rolesAbi, functionName: call.functionName, args: call.args as never })
  return { to: rolesModifier, value: '0' as const, data }
}

/** Wrap a planned Safe transaction so the keeper executes it through the role. */
export function wrapWithRole(
  transaction: UnsignedTransaction,
  keeper: Address,
  rolesModifier: Address,
  roleKey: Hex,
): UnsignedTransaction {
  // The role is configured with ExecutionOptions.None everywhere; a plan
  // carrying ether means a native-leg builder slipped through.
  if (transaction.value !== 0n) throw new Error('Safe mode plans must not send ether; native-leg pools are not supported')
  return {
    from: keeper,
    to: rolesModifier,
    value: 0n,
    data: encodeFunctionData({
      abi: rolesAbi,
      functionName: 'execTransactionWithRole',
      args: [transaction.to, transaction.value, transaction.data, 0, roleKey, true],
    }),
  }
}
