import Safe, { extractPasskeyData } from '@safe-global/protocol-kit'
import type { PasskeyArgType } from '@safe-global/protocol-kit'
import { zeroAddress } from 'viem'
import type { SafeTransaction } from './model'

export async function createSafePasskey(name: string, rpId: string): Promise<PasskeyArgType> {
  const credential = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: 'Pecu', id: rpId },
    user: { id: crypto.getRandomValues(new Uint8Array(32)), name, displayName: name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none', timeout: 120000,
  } })
  if (!credential) throw new Error('Passkey creation was cancelled.')
  const data = await extractPasskeyData(credential)
  return { ...data, verifierAddress: '0xc2b78104907F722DABAc4C69f826a522B2754De4' }
}

export async function signSafeWithPasskey(provider: string, passkey: PasskeyArgType, transaction: SafeTransaction) {
  if (BigInt(transaction.nonce) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Safe nonce exceeds the signer library range.')
  const safe = await Safe.init({ provider, signer: passkey, safeAddress: transaction.safe })
  if (await safe.getChainId() !== BigInt(transaction.chainId)) throw new Error('Passkey provider chain differs from the proposal.')
  const proposal = await safe.createTransaction({ transactions: [{ to: transaction.to, data: transaction.data, value: transaction.value, operation: transaction.operation ?? 0 }], options: { nonce: Number(transaction.nonce), safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: zeroAddress, refundReceiver: zeroAddress } })
  if ((await safe.getTransactionHash(proposal)).toLowerCase() !== transaction.hash.toLowerCase()) throw new Error('Passkey proposal hash differs from the reviewed transaction.')
  const signed = await safe.signTransaction(proposal)
  return [...signed.signatures.values()].map(signature => ({ owner: signature.signer, data: signature.data, contract: signature.isContractSignature }))
}
