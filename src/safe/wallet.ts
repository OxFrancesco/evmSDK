import { Effect } from 'effect'
import { concatHex, encodeAbiParameters, encodeFunctionData, getCreate2Address, keccak256, zeroAddress } from 'viem'
import { prepare } from '../execution'
import { publicOperation } from '../model'
import { Network, rpc } from '../network'
import { SafeCreateInput, SafeDeployInput, SafeTarget } from './model'
import { decodeSafe, deployments, factoryAbi, proxyCreationCode, safeAbi, safeError, validateOwners, verifyCode, verifySafe } from './contracts'

export const safeInfo = Effect.fn('Safe.info')(function* (raw: typeof SafeTarget.Type) {
  const input = yield* decodeSafe(SafeTarget, raw)
  const connection = yield* (yield* Network).client(input.chainId)
  const block = yield* rpc(() => connection.getBlockNumber())
  const modules = yield* verifySafe(input.chainId, input.safe, block)
  const [owners, threshold, nonce, version] = yield* Effect.all([
    rpc(() => connection.readContract({ address: input.safe, abi: safeAbi, functionName: 'getOwners', blockNumber: block })),
    rpc(() => connection.readContract({ address: input.safe, abi: safeAbi, functionName: 'getThreshold', blockNumber: block })),
    rpc(() => connection.readContract({ address: input.safe, abi: safeAbi, functionName: 'nonce', blockNumber: block })),
    rpc(() => connection.readContract({ address: input.safe, abi: safeAbi, functionName: 'VERSION', blockNumber: block })),
  ], { concurrency: 4 })
  if (version !== '1.4.1') return yield* safeError('Unsupported Safe version.')
  yield* validateOwners(owners, Number(threshold), input.safe)
  return { ...input, modules, owners, threshold: Number(threshold), nonce: nonce.toString(), version, block: block.toString() }
})

export const safePredict = Effect.fn('Safe.predict')(function* (raw: typeof SafeCreateInput.Type) {
  const input = yield* decodeSafe(SafeCreateInput, raw)
  yield* validateOwners(input.owners, input.threshold)
  const registry = yield* deployments(input.chainId)
  const connection = yield* (yield* Network).client(input.chainId)
  const block = yield* rpc(() => connection.getBlockNumber())
  const factory = registry.factory.address
  const singleton = input.chainId === 1 ? registry.singleton : registry.l2
  yield* verifyCode(input.chainId, factory, registry.factory.codeHash, block)
  yield* verifyCode(input.chainId, singleton.address, singleton.codeHash, block)
  const initializer = encodeFunctionData({ abi: safeAbi, functionName: 'setup', args: [input.owners, BigInt(input.threshold), zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress] })
  const salt = keccak256(concatHex([keccak256(initializer), encodeAbiParameters([{ type: 'uint256' }], [BigInt(input.saltNonce)])]))
  const safe = getCreate2Address({ from: factory, salt, bytecode: concatHex([proxyCreationCode, encodeAbiParameters([{ type: 'address' }], [singleton.address])]) })
  yield* validateOwners(input.owners, input.threshold, safe)
  const code = yield* rpc(() => connection.getCode({ address: safe, blockNumber: block }))
  return { ...input, safe, factory, singleton: singleton.address, data: encodeFunctionData({ abi: factoryAbi, functionName: 'createProxyWithNonce', args: [singleton.address, initializer, BigInt(input.saltNonce)] }), deployed: Boolean(code && code !== '0x') }
})

export const safeDeploy = Effect.fn('Safe.deploy')(function* (raw: typeof SafeDeployInput.Type) {
  const input = yield* decodeSafe(SafeDeployInput, raw)
  const deployment = yield* safePredict({ chainId: input.chainId, owners: input.owners, threshold: input.threshold, saltNonce: input.saltNonce })
  // prepare reuses the persisted action when the same key is retried.
  const operation = yield* prepare({ chainId: input.chainId, account: input.account, to: deployment.factory, data: deployment.data, value: '0', key: input.key })
  return { ...publicOperation(operation), deployment }
})
