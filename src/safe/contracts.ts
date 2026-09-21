import { verifyModule } from './module-contracts'
import { getProxyFactoryDeployment, getSafeL2SingletonDeployment, getSafeSingletonDeployment } from '@safe-global/safe-deployments'
import proxy from '@safe-global/safe-contracts/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json'
import { Effect, Schema } from 'effect'
import { keccak256, parseAbi, zeroAddress } from 'viem'
import { Address, EvmError, Hex } from '../model'
import { Network, rpc } from '../network'

export const safeAbi = parseAbi([
  'function setup(address[] owners,uint256 threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function masterCopy() view returns (address)',
  'function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce) view returns (bytes32)',
  'function approvedHashes(address owner,bytes32 hash) view returns (uint256)',
  'function approveHash(bytes32 hash)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'function addOwnerWithThreshold(address owner,uint256 threshold)',
  'function removeOwner(address previousOwner,address owner,uint256 threshold)',
  'function swapOwner(address previousOwner,address oldOwner,address newOwner)',
  'function enableModule(address module)',
  'function disableModule(address previousModule,address module)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function setFallbackHandler(address handler)',
  'function changeThreshold(uint256 threshold)',
])
export const factoryAbi = parseAbi(['function createProxyWithNonce(address singleton,bytes initializer,uint256 saltNonce) returns (address proxy)'])
export const sentinel = '0x0000000000000000000000000000000000000001'
export const safeError = (message: string) => new EvmError({ code: 'InvalidInput', message, retryable: false })
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the schema decoder at the public SDK boundary.
export const decodeSafe = <A, I>(schema: Schema.Codec<A, I>, value: unknown) => Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: 'error' }).pipe(Effect.mapError(error => safeError(error.message)))
export const proxyCreationCode = Schema.decodeUnknownSync(Hex)(proxy.bytecode)
const proxyRuntimeHash = keccak256(Schema.decodeUnknownSync(Hex)(proxy.deployedBytecode))

export const deployments = Effect.fn('Safe.deployments')(function* (chainId: number) {
  const filter = { version: '1.4.1', network: chainId === 31337 ? undefined : String(chainId) }
  const factory = getProxyFactoryDeployment(filter)?.deployments.canonical
  const singleton = getSafeSingletonDeployment(filter)?.deployments.canonical
  const l2 = getSafeL2SingletonDeployment(filter)?.deployments.canonical
  if (!factory || !singleton || !l2) return yield* safeError(`Safe 1.4.1 has no registered deployment on chain ${chainId}.`)
  return { factory: { ...factory, address: yield* decodeSafe(Address, factory.address) }, singleton: { ...singleton, address: yield* decodeSafe(Address, singleton.address) }, l2: { ...l2, address: yield* decodeSafe(Address, l2.address) } }
})

export const verifyCode = Effect.fn('Safe.verifyCode')(function* (chainId: number, address: `0x${string}`, hash: string, block: bigint) {
  const connection = yield* (yield* Network).client(chainId)
  const code = yield* rpc(() => connection.getCode({ address, blockNumber: block }))
  if (!code || keccak256(code) !== hash) return yield* safeError(`Unrecognized Safe contract code at ${address}.`)
})

export const verifySafe = Effect.fn('Safe.verify')(function* (chainId: number, safe: `0x${string}`, block: bigint) {
  const registry = yield* deployments(chainId)
  yield* verifyCode(chainId, safe, proxyRuntimeHash, block)
  const connection = yield* (yield* Network).client(chainId)
  const singleton = yield* rpc(() => connection.readContract({ address: safe, abi: safeAbi, functionName: 'masterCopy', blockNumber: block }))
  const expected = [registry.singleton, registry.l2].find(item => item.address.toLowerCase() === singleton.toLowerCase())
  if (!expected) return yield* safeError('Only official Safe 1.4.1 singletons are supported.')
  yield* verifyCode(chainId, singleton, expected.codeHash, block)
  const [modules, next] = yield* rpc(() => connection.readContract({ address: safe, abi: safeAbi, functionName: 'getModulesPaginated', args: [sentinel, 32n], blockNumber: block }))
  if (next !== sentinel) return yield* safeError('Safe has too many enabled modules to review.')
  for (const module of modules) yield* verifyModule(chainId, safe, module, block)
  return modules
})

export const validateOwners = Effect.fn('Safe.validateOwners')(function* (owners: ReadonlyArray<`0x${string}`>, threshold: number, safe?: string) {
  const unique = new Set(owners.map(owner => owner.toLowerCase()))
  if (owners.length < 1 || owners.length > 32 || unique.size !== owners.length || owners.some(owner => [zeroAddress, sentinel, safe?.toLowerCase()].includes(owner.toLowerCase()))) return yield* safeError('Provide 1 to 32 distinct owners, excluding zero, the sentinel, and the Safe itself.')
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) return yield* safeError('Threshold must be between 1 and the number of owners.')
})
