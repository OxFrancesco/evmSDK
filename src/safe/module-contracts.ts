import { Effect } from 'effect'
import { concatHex, parseAbi } from 'viem'
import { Address } from '../model'
import { Network, rpc } from '../network'
import registry from './deployments.json'
import { decodeSafe, safeError, verifyCode } from './contracts'

export const allowanceAbi = parseAbi([
  'function addDelegate(address delegate)',
  'function removeDelegate(address delegate,bool removeAllowances)',
  'function setAllowance(address delegate,address token,uint96 amount,uint16 resetTimeMin,uint32 resetBaseMin)',
  'function deleteAllowance(address delegate,address token)',
  'function getTokenAllowance(address safe,address delegate,address token) view returns (uint256[5])',
  'function executeAllowanceTransfer(address safe,address token,address to,uint96 amount,address paymentToken,uint96 payment,address delegate,bytes signature)',
])
export const rolesAbi = parseAbi([
  'function owner() view returns (address)', 'function avatar() view returns (address)', 'function target() view returns (address)',
  'function assignRoles(address member,bytes32[] roleKeys,bool[] memberOf)',
  'function scopeTarget(bytes32 roleKey,address targetAddress)',
  'function revokeTarget(bytes32 roleKey,address targetAddress)',
  'function scopeFunction(bytes32 roleKey,address targetAddress,bytes4 selector,(uint8 parent,uint8 paramType,uint8 operator,bytes compValue)[] conditions,uint8 options)',
  'function execTransactionWithRole(address to,uint256 value,bytes data,uint8 operation,bytes32 roleKey,bool shouldRevert) returns (bool)',
])
export const extension = Effect.fn('Safe.extension')(function* (chainId: number, name: keyof typeof registry) {
  const entry = registry[name]
  const address = yield* decodeSafe(Address, entry.address)
  const connection = yield* (yield* Network).client(chainId)
  const block = yield* rpc(() => connection.getBlockNumber())
  yield* verifyCode(chainId, address, entry.codeHash, block)
  return address
})

export const verifyRoles = Effect.fn('Safe.verifyRoles')(function* (chainId: number, safe: `0x${string}`, address: `0x${string}`, block: bigint) {
  const mastercopy = yield* extension(chainId, 'roles')
  const connection = yield* (yield* Network).client(chainId)
  const code = yield* rpc(() => connection.getCode({ address, blockNumber: block }))
  const expected = concatHex(['0x363d3d373d3d3d363d73', mastercopy, '0x5af43d82803e903d91602b57fd5bf3'])
  if (code?.toLowerCase() !== expected.toLowerCase()) return yield* safeError('Unrecognized Zodiac Roles proxy.')
  for (const functionName of ['owner', 'avatar', 'target'] as const) {
    const value = yield* rpc(() => connection.readContract({ address, abi: rolesAbi, functionName, blockNumber: block }))
    if (value.toLowerCase() !== safe.toLowerCase()) return yield* safeError('The Safe must own and be the avatar and target of its Roles module.')
  }
})

export const verifyModule = Effect.fn('Safe.verifyModule')(function* (chainId: number, safe: `0x${string}`, address: `0x${string}`, block: bigint) {
  for (const name of ['allowance', 'erc4337'] as const) {
    if (address.toLowerCase() === registry[name].address.toLowerCase()) {
      yield* extension(chainId, name)
      return
    }
  }
  yield* verifyRoles(chainId, safe, address, block)
})
