// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import { concatHex, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { abis } from './abis'
import { SugarClient } from './client'
import { getChainSettings, HYPERLANE_RELAYERS, HYPERLANE_RELAY_URL } from './config'
import { randomSalt, serializeIcaCalls, tokenEquals } from './helpers'
import { buildSuperSwapData, setupPlanner } from './planner'
import type { ChainId, Quote, SugarClientOptions, SuperSwapData, SuperswapQuote, Token, UnsignedTransaction } from './types'

export const SUPERSWAP_SUPPORTED_CHAINS = ['OP', 'Lisk', 'Uni'] as const

const SUPERSWAP_CHAIN_NAMES: readonly string[] = SUPERSWAP_SUPPORTED_CHAINS

const domainsAbi = parseAbi(['function domains(uint256 chainId) view returns (uint256 domain)'])

export type SuperswapRelayArgs = {
  calls: ReturnType<typeof serializeIcaCalls>
  salt: Hex
  commitmentDispatchTx: Hex
  originDomain: number
}

export type SuperswapResult = {
  transactions: UnsignedTransaction[]
  swapData?: SuperSwapData
  relayArgs(commitmentDispatchTx: Hex): SuperswapRelayArgs
}

export interface SuperswapRelayer {
  shareCalls(args: SuperswapRelayArgs): Promise<void>
}

export class HttpSuperswapRelayer implements SuperswapRelayer {
  constructor(readonly url = HYPERLANE_RELAY_URL, readonly relayers: readonly Address[] = HYPERLANE_RELAYERS) {}

  async shareCalls(args: SuperswapRelayArgs): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        commitmentDispatchTx: args.commitmentDispatchTx,
        originDomain: args.originDomain,
        calls: args.calls,
        salt: args.salt,
        relayers: this.relayers,
      }),
    })
    if (!response.ok) throw new Error(`Hyperlane relay failed: ${response.status} ${await response.text()}`)
  }
}

export class MockSuperswapRelayer implements SuperswapRelayer {
  callCount = 0
  async shareCalls(_args: SuperswapRelayArgs): Promise<void> { this.callCount++ }
}

function makeResult(transactions: UnsignedTransaction[], swapData?: SuperSwapData): SuperswapResult {
  return {
    transactions,
    swapData,
    relayArgs(commitmentDispatchTx) {
      if (!swapData) throw new Error('This Superswap does not require a relayer step')
      return {
        calls: serializeIcaCalls(swapData.calls),
        salt: swapData.salt,
        commitmentDispatchTx,
        originDomain: swapData.originDomain,
      }
    },
  }
}

export function createSuperswapQuote(input: {
  fromToken: Token
  toToken: Token
  fromBridgeToken: Token
  toBridgeToken: Token
  amountIn: bigint
  originQuote?: Quote
  destinationQuote?: Quote
}): SuperswapQuote {
  const bridgedAmount = tokenEquals(input.fromToken, input.fromBridgeToken) ? input.amountIn : input.originQuote?.amountOut
  if (bridgedAmount === undefined) throw new Error('originQuote must be set when the origin token is not the bridge token')
  const isBridge = tokenEquals(input.fromToken, input.fromBridgeToken) && tokenEquals(input.toToken, input.toBridgeToken)
  return {
    ...input,
    bridgedAmount,
    amountOut: input.destinationQuote?.amountOut ?? bridgedAmount,
    isBridge,
  }
}

export class Superswap {
  readonly relayer: SuperswapRelayer
  private readonly options: SugarClientOptions
  private readonly clientFactory: (chainId: ChainId | number, options: SugarClientOptions) => SugarClient

  constructor(options: SugarClientOptions & {
    relayer?: SuperswapRelayer
    clientFactory?: (chainId: ChainId | number, options: SugarClientOptions) => SugarClient
  } = {}) {
    const { relayer, clientFactory, ...clientOptions } = options
    this.options = clientOptions
    this.relayer = relayer ?? new HttpSuperswapRelayer()
    this.clientFactory = clientFactory ?? ((chainId, settings) => new SugarClient(chainId, settings))
  }

  private client(chainId: ChainId, withAccount = false): SugarClient {
    return this.clientFactory(chainId, { ...this.options, account: withAccount ? this.options.account : undefined })
  }

  private checkSupport(fromToken: Token, toToken: Token): void {
    const from = getChainSettings(fromToken.chainId).chainName
    const to = getChainSettings(toToken.chainId).chainName
    if (!SUPERSWAP_CHAIN_NAMES.includes(from) || !SUPERSWAP_CHAIN_NAMES.includes(to)) {
      throw new Error(`Superswap only supports ${SUPERSWAP_SUPPORTED_CHAINS.join(', ')}. Got ${from} -> ${to}`)
    }
  }

  async getDomain(chainId: ChainId | number): Promise<number> {
    const op = this.client(10)
    const domain = await op.publicClient.readContract({
      address: op.settings.messageModuleContractAddress,
      abi: domainsAbi,
      functionName: 'domains',
      args: [BigInt(chainId)],
    })
    return domain === 0n ? Number(chainId) : Number(domain)
  }

  async getQuote(fromToken: Token, toToken: Token, amount: bigint): Promise<SuperswapQuote | undefined> {
    this.checkSupport(fromToken, toToken)
    const fromClient = this.client(fromToken.chainId, true)
    const toClient = this.client(toToken.chainId)
    const [fromBridgeToken, toBridgeToken] = await Promise.all([fromClient.getBridgeToken(), toClient.getBridgeToken()])
    if (tokenEquals(fromToken, fromBridgeToken) && tokenEquals(toToken, toBridgeToken)) {
      return createSuperswapQuote({ fromToken, toToken, fromBridgeToken, toBridgeToken, amountIn: amount })
    }
    let originQuote: Quote | undefined
    if (!tokenEquals(fromToken, fromBridgeToken)) {
      originQuote = await fromClient.getQuote(fromToken, fromBridgeToken, amount)
      if (!originQuote) return undefined
    }
    let destinationQuote: Quote | undefined
    if (!tokenEquals(toToken, toBridgeToken)) {
      const destinationDomain = await this.getDomain(toToken.chainId)
      const userIca = await fromClient.getRemoteInterchainAccount(destinationDomain)
      const existingBalance = await toClient.getTokenBalance(toBridgeToken, userIca)
      const bridgedAmount = (originQuote?.amountOut ?? amount) + existingBalance
      destinationQuote = await toClient.getQuote(toBridgeToken, toToken, bridgedAmount)
      if (!destinationQuote) return undefined
    }
    return createSuperswapQuote({ fromToken, toToken, fromBridgeToken, toBridgeToken, amountIn: amount, originQuote, destinationQuote })
  }

  async bridgeFromQuote(quote: SuperswapQuote): Promise<SuperswapResult> {
    if (!quote.isBridge) throw new Error('bridgeFromQuote can only be used for bridge quotes')
    this.checkSupport(quote.fromToken, quote.toToken)
    const client = this.client(quote.fromToken.chainId, true)
    if (!client.account) throw new Error('Cannot bridge without an account')
    return makeResult(await client.bridge(quote.fromToken, quote.amountIn, await this.getDomain(quote.toToken.chainId)))
  }

  async swap(fromToken: Token, toToken: Token, amount: bigint, slippage?: number): Promise<SuperswapResult> {
    const quote = await this.getQuote(fromToken, toToken, amount)
    if (!quote) throw new Error(`No quote found for ${fromToken.symbol} -> ${toToken.symbol}`)
    return this.swapFromQuote(quote, slippage)
  }

  async swapFromQuote(quote: SuperswapQuote, slippage?: number, salt = randomSalt()): Promise<SuperswapResult> {
    this.checkSupport(quote.fromToken, quote.toToken)
    if (quote.isBridge) return this.bridgeFromQuote(quote)
    const fromClient = this.client(quote.fromToken.chainId, true)
    const toClient = this.client(quote.toToken.chainId)
    if (!fromClient.account) throw new Error('Cannot superswap without an account')
    const [originDomain, destinationDomain] = await Promise.all([this.getDomain(quote.fromToken.chainId), this.getDomain(quote.toToken.chainId)])
    const userIca = await fromClient.getRemoteInterchainAccount(destinationDomain)
    const [bridgeFee, xchainFee, originHook, userIcaBalance] = await Promise.all([
      fromClient.getBridgeFee(destinationDomain),
      tokenEquals(quote.toToken, quote.toBridgeToken) ? 0n : fromClient.getXchainFee(destinationDomain),
      fromClient.getIcaHook(),
      toClient.getUserIcaBalance(userIca),
    ])
    const effectiveSlippage = slippage ?? fromClient.settings.swapSlippage
    const swapData = buildSuperSwapData({
      fromToken: quote.fromToken, toToken: quote.toToken,
      fromBridgeToken: quote.fromBridgeToken, toBridgeToken: quote.toBridgeToken,
      account: fromClient.account, userIca, userIcaBalance, originDomain,
      originBridge: fromClient.settings.bridgeContractAddress, originHook,
      originIcaRouter: fromClient.settings.interchainRouterContractAddress,
      destinationIcaRouter: toClient.settings.interchainRouterContractAddress,
      destinationRouter: toClient.settings.swapperContractAddress, destinationDomain,
      slippage: effectiveSlippage, swapperContractAddress: toClient.settings.swapperContractAddress,
      salt, bridgeFee, xchainFee, destinationQuote: quote.destinationQuote,
    })
    const originPlan = quote.originQuote
      ? setupPlanner(quote.originQuote, effectiveSlippage, fromClient.settings.swapperContractAddress, fromClient.settings.swapperContractAddress)
      : undefined
    const commands = originPlan ? concatHex([originPlan.commands, swapData.destinationPlanner.commands]) : swapData.destinationPlanner.commands
    const inputs = [...(originPlan?.inputs ?? []), ...swapData.destinationPlanner.inputs]
    const approval = await fromClient.setTokenAllowance(quote.fromToken, fromClient.settings.swapperContractAddress, quote.amountIn)
    const totalFee = bridgeFee + xchainFee
    const messageValue = quote.fromToken.wrappedTokenAddress ? quote.amountIn + totalFee : totalFee
    const main: UnsignedTransaction = {
      from: fromClient.account,
      to: fromClient.settings.swapperContractAddress,
      data: encodeFunctionData({ abi: abis.swapper, functionName: 'execute', args: [commands, inputs] }),
      value: messageValue,
    }
    return makeResult([approval, main].filter((tx): tx is UnsignedTransaction => tx !== undefined), swapData.needsRelay ? swapData : undefined)
  }

  async relay(result: SuperswapResult, commitmentDispatchTx: Hex): Promise<void> {
    await this.relayer.shareCalls(result.relayArgs(commitmentDispatchTx))
  }
}

export type SuperswapTxs = SuperswapResult
export {
  HttpSuperswapRelayer as HTTPSuperswapRelayer,
  Superswap as AsyncSuperswap,
  Superswap as SuperswapCommon,
}
