import { Schema } from 'effect'
import { commands } from '../catalog'
export interface Field {
  readonly name: string
  readonly label: string
  readonly kind: 'text' | 'number' | 'json'
  readonly initial: string
  readonly optional?: boolean
  readonly choices?: ReadonlyArray<{ label: string; value: string }>
}
const field = (name: string, label = name, initial = '', kind: Field['kind'] = 'text', optional = false): Field => ({ name, label, initial, kind, optional })
const chain = field('chainId', 'Chain', '8453', 'number')
const address = field('address', 'Contract address')
const abi = field('abi', 'ABI JSON', '', 'json', true)
const signatures = field('signatures', 'ABI signatures JSON', '', 'json', true)
const account = field('account', 'Signer address')
const id = field('id', 'Operation ID')
const contract = [chain, address, signatures, abi, field('block', 'Block', '', 'text', true)]
const call = [...contract, field('functionName', 'Function'), field('args', 'Arguments JSON', '[]', 'json')]

export const forms = new Map<string, ReadonlyArray<Field>>([
  ['inspect', contract], ['read', [...call, { ...account, optional: true }]],
  ['prepare', [chain, account, field('to', 'Destination'), field('data', 'Calldata', '0x'), field('value', 'Value in wei', '0'), field('key', 'Idempotency key')]],
  ['prepare-call', [...call, account, field('value', 'Value in wei', '0'), field('key', 'Idempotency key')]],
  ['execute', [id]], ['status', [id]], ['wait', [id]], ['cancel', [id]], ['operations', []], ['wallet', []],
  ['balance', [chain, field('address', 'Wallet address')]], ['token', [chain, field('address', 'Wallet address'), field('token', 'Token address')]],
  ['block', [chain, field('number', 'Block', '', 'text', true)]], ['transaction', [chain, field('hash', 'Transaction hash')]],
  ['logs', [chain, address, field('fromBlock', 'From block'), field('toBlock', 'To block'), field('offset', 'Offset', '0', 'number')]],
  ['workspace', []], ['save', [field('name', 'Alias'), chain, address]], ['remove', [field('name', 'Alias')]],
  ['wallet-connect', [{ ...field('kind', 'Connection', 'browser'), choices: [{ label: 'Browser wallet · Rabby, MetaMask and other extensions', value: 'browser' }, { label: 'WalletConnect · mobile wallet or QR', value: 'walletconnect' }, { label: 'Smart wallet · BeeGreat login and Crossmint', value: 'crossmint' }] }, chain, field('name', 'Wallet name', 'main')]],
  ['watch', [chain, field('count', 'Samples', '3', 'number'), field('intervalMs', 'Interval in milliseconds', '2000', 'number')]],
])

for (const command of commands) {
  if (forms.has(command.name)) continue
  const schema = command.inputSchema.schema
  if (!('properties' in schema) || !schema.properties) { forms.set(command.name, []); continue }
  const requiredValue = Schema.decodeUnknownOption(Schema.Array(Schema.String))('required' in schema ? schema.required : [])
  const required = requiredValue._tag === 'Some' ? requiredValue.value : []
  forms.set(command.name, Object.entries(schema.properties).filter(([name]) => name !== 'approval').map(([name, value]) => {
    const type = 'type' in value ? value.type : undefined
    const kind = type === 'integer' || type === 'number' ? 'number' : type === 'string' ? 'text' : 'json'
    const initial = name === 'chainId' || name === 'originChainId' ? '8453' : name === 'destinationChainId' ? '42161' : name === 'slippage' ? '0.5' : name === 'kind' && command.name === 'wallet-connect' ? 'browser' : name === 'name' && command.name === 'wallet-connect' ? 'main' : name === 'key' ? crypto.randomUUID() : type === 'boolean' ? 'false' : type === 'array' ? '[]' : ''
    return field(name, name.replace(/([A-Z])/g, ' $1').toLowerCase(), initial, kind, !required.includes(name))
  }))
}
