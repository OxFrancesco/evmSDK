import { buildSignatureBytes, EthSafeSignature } from '@safe-global/protocol-kit'
import { Effect, Schema } from 'effect'
import { encodeFunctionData, parseAbi, zeroAddress } from 'viem'
import { Address, Hex, Id, publicOperation } from '../model'
import { prepare } from '../execution'
import { Network, rpc } from '../network'
import { decodeSafe, safeAbi, safeError } from './contracts'
import { extension } from './module-contracts'
import { SafeApprovalInput, SafeTarget, SafeUint } from './model'
import { safeApprovals, safeChangeOwner } from './transactions'

export const passkeyFactoryAbi = parseAbi(['function getSigner(uint256 x,uint256 y,uint176 verifiers) view returns (address)', 'function createSigner(uint256 x,uint256 y,uint176 verifiers) returns (address)'])
export const SafePasskey = Schema.Struct({ x: SafeUint, y: SafeUint })
export const SafePasskeyInput = Schema.Struct({ ...SafeTarget.fields, passkey: SafePasskey })
export const SafePasskeyDeployInput = Schema.Struct({ ...SafePasskeyInput.fields, account: Address, key: Id })
export const SafePasskeyOwnerInput = Schema.Struct({ ...SafePasskeyInput.fields, threshold: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })) })
export const SafeSignaturesInput = Schema.Struct({ ...SafeApprovalInput.fields, signatures: Schema.Array(Schema.Struct({ owner: Address, data: Hex, contract: Schema.Boolean })).check(Schema.isMinLength(1), Schema.isMaxLength(32)) })

export const safePasskeyAddress = Effect.fn('Safe.passkeyAddress')(function* (raw: typeof SafePasskeyInput.Type) {
  const input = yield* decodeSafe(SafePasskeyInput, raw)
  const factory = yield* extension(input.chainId, 'passkeyFactory')
  const verifier = yield* extension(input.chainId, 'p256')
  const connection = yield* (yield* Network).client(input.chainId)
  const { x, y } = input.passkey
  const prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn
  const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn
  const px = BigInt(x); const py = BigInt(y)
  if (px >= prime || py >= prime || (py * py - px * px * px + 3n * px - b) % prime !== 0n) return yield* safeError('Invalid P-256 public key.')
  const owner = yield* rpc(() => connection.readContract({ address: factory, abi: passkeyFactoryAbi, functionName: 'getSigner', args: [px, py, BigInt(verifier)] }))
  const code = yield* rpc(() => connection.getCode({ address: owner }))
  return { owner, factory, verifier, deployed: Boolean(code && code !== '0x') }
})

export const safePasskeyDeploy = Effect.fn('Safe.passkeyDeploy')(function* (raw: typeof SafePasskeyDeployInput.Type) {
  const input = yield* decodeSafe(SafePasskeyDeployInput, raw)
  const signer = yield* safePasskeyAddress({ chainId: input.chainId, safe: input.safe, passkey: input.passkey })
  const data = encodeFunctionData({ abi: passkeyFactoryAbi, functionName: 'createSigner', args: [BigInt(input.passkey.x), BigInt(input.passkey.y), BigInt(signer.verifier)] })
  return { ...publicOperation(yield* prepare({ chainId: input.chainId, account: input.account, to: signer.factory, value: '0', data, key: input.key })), owner: signer.owner }
})

export const safePasskeyOwner = Effect.fn('Safe.passkeyOwner')(function* (raw: typeof SafePasskeyOwnerInput.Type) {
  const input = yield* decodeSafe(SafePasskeyOwnerInput, raw)
  const signer = yield* safePasskeyAddress({ chainId: input.chainId, safe: input.safe, passkey: input.passkey })
  if (!signer.deployed) return yield* safeError('Deploy the passkey signer before adding it as an owner.')
  return yield* safeChangeOwner({ chainId: input.chainId, safe: input.safe, change: { kind: 'add', owner: signer.owner, threshold: input.threshold } })
})

export const safeExecuteSignatures = Effect.fn('Safe.executeSignatures')(function* (raw: typeof SafeSignaturesInput.Type) {
  const input = yield* decodeSafe(SafeSignaturesInput, raw)
  const status = yield* safeApprovals({ chainId: input.chainId, transaction: input.transaction })
  const owners = new Set(input.signatures.map(signature => signature.owner.toLowerCase()))
  if (owners.size !== input.signatures.length || owners.size < status.threshold || input.signatures.some(signature => !status.owners.some(owner => owner.toLowerCase() === signature.owner.toLowerCase()))) return yield* safeError('Provide distinct current owner signatures meeting the threshold.')
  const signatures = yield* decodeSafe(Hex, buildSignatureBytes(input.signatures.map(signature => new EthSafeSignature(signature.owner, signature.data, signature.contract))))
  const tx = input.transaction
  const data = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [tx.to, BigInt(tx.value), tx.data, tx.operation ?? 0, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] })
  return publicOperation(yield* prepare({ chainId: input.chainId, account: input.account, to: tx.safe, value: '0', data, key: input.key }))
})
