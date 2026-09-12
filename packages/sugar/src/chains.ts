// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import { SugarClient } from './client'
import { isSupportedChainId } from './config'
import { KNOWN_TOKENS } from './known-tokens'
import type { ChainId, SugarClientOptions, Token } from './types'

export class OPChain extends SugarClient {
  static readonly tokens = KNOWN_TOKENS[10]
  static readonly usdc = OPChain.tokens.usdc
  static readonly velo = OPChain.tokens.velo
  static readonly eth = OPChain.tokens.eth
  static readonly oUsdt = OPChain.tokens.oUsdt
  readonly usdc = OPChain.usdc
  readonly velo = OPChain.velo
  readonly eth = OPChain.eth
  readonly oUsdt = OPChain.oUsdt
  constructor(options: SugarClientOptions = {}) { super(10, options) }
}

export class BaseChain extends SugarClient {
  static readonly tokens = KNOWN_TOKENS[8453]
  static readonly usdc = BaseChain.tokens.usdc
  static readonly aero = BaseChain.tokens.aero
  static readonly eth = BaseChain.tokens.eth
  readonly usdc = BaseChain.usdc
  readonly aero = BaseChain.aero
  readonly eth = BaseChain.eth
  constructor(options: SugarClientOptions = {}) { super(8453, options) }
}

export class UniChain extends SugarClient {
  static readonly tokens = KNOWN_TOKENS[130]
  static readonly eth = UniChain.tokens.eth
  static readonly oUsdt = UniChain.tokens.oUsdt
  static readonly usdc = UniChain.tokens.usdc
  readonly eth = UniChain.eth
  readonly oUsdt = UniChain.oUsdt
  readonly usdc = UniChain.usdc
  constructor(options: SugarClientOptions = {}) { super(130, options) }
}

export class LiskChain extends SugarClient {
  static readonly tokens = KNOWN_TOKENS[1135]
  static readonly oUsdt = LiskChain.tokens.oUsdt
  static readonly lsk = LiskChain.tokens.lsk
  static readonly eth = LiskChain.tokens.eth
  static readonly usdt = LiskChain.tokens.usdt
  readonly oUsdt = LiskChain.oUsdt
  readonly lsk = LiskChain.lsk
  readonly eth = LiskChain.eth
  readonly usdt = LiskChain.usdt
  constructor(options: SugarClientOptions = {}) { super(1135, options) }
}

export class ModeChain extends SugarClient {
  static readonly tokens = KNOWN_TOKENS[34443]
  static readonly eth = ModeChain.tokens.eth
  static readonly oUsdt = ModeChain.tokens.oUsdt
  static readonly usdc = ModeChain.tokens.usdc
  readonly eth = ModeChain.eth
  readonly oUsdt = ModeChain.oUsdt
  readonly usdc = ModeChain.usdc
  constructor(options: SugarClientOptions = {}) { super(34443, options) }
}

export class FraxtalChain extends SugarClient {
  static readonly tokens = KNOWN_TOKENS[252]
  static readonly frax = FraxtalChain.tokens.frax
  static readonly oUsdt = FraxtalChain.tokens.oUsdt
  static readonly frxUsd = FraxtalChain.tokens.frxUsd
  readonly frax = FraxtalChain.frax
  readonly oUsdt = FraxtalChain.oUsdt
  readonly frxUsd = FraxtalChain.frxUsd
  constructor(options: SugarClientOptions = {}) { super(252, options) }
}

export class InkChain extends SugarClient {
  static readonly tokens = KNOWN_TOKENS[57073]
  static readonly eth = InkChain.tokens.eth
  static readonly oUsdt = InkChain.tokens.oUsdt
  static readonly usdc = InkChain.tokens.usdc
  readonly eth = InkChain.eth
  readonly oUsdt = InkChain.oUsdt
  readonly usdc = InkChain.usdc
  constructor(options: SugarClientOptions = {}) { super(57073, options) }
}

export class SoneiumChain extends SugarClient {
  static readonly tokens = KNOWN_TOKENS[1868]
  static readonly eth = SoneiumChain.tokens.eth
  static readonly oUsdt = SoneiumChain.tokens.oUsdt
  static readonly usdc = SoneiumChain.tokens.usdc
  readonly eth = SoneiumChain.eth
  readonly oUsdt = SoneiumChain.oUsdt
  readonly usdc = SoneiumChain.usdc
  constructor(options: SugarClientOptions = {}) { super(1868, options) }
}

export class SuperseedChain extends SugarClient {
  static readonly tokens = KNOWN_TOKENS[5330]
  static readonly eth = SuperseedChain.tokens.eth
  static readonly oUsdt = SuperseedChain.tokens.oUsdt
  static readonly usdc = SuperseedChain.tokens.usdc
  readonly eth = SuperseedChain.eth
  readonly oUsdt = SuperseedChain.oUsdt
  readonly usdc = SuperseedChain.usdc
  constructor(options: SugarClientOptions = {}) { super(5330, options) }
}

export class CeloChain extends SugarClient {
  static readonly tokens = KNOWN_TOKENS[42220]
  static readonly celo = CeloChain.tokens.celo
  static readonly oUsdt = CeloChain.tokens.oUsdt
  static readonly usdt = CeloChain.tokens.usdt
  static readonly weth = CeloChain.tokens.weth
  readonly celo = CeloChain.celo
  readonly oUsdt = CeloChain.oUsdt
  readonly usdt = CeloChain.usdt
  readonly weth = CeloChain.weth
  constructor(options: SugarClientOptions = {}) { super(42220, options) }
}

export class LiskChainSimnet extends LiskChain {
  readonly isSimnet = true
  constructor(options: SugarClientOptions = {}) {
    super({ ...options, rpcUrl: options.rpcUrl ?? 'http://127.0.0.1:4445', settings: { requestConcurrency: 1, ...options.settings } })
  }
}

export class UniChainSimnet extends UniChain {
  readonly isSimnet = true
  constructor(options: SugarClientOptions = {}) {
    super({ ...options, rpcUrl: options.rpcUrl ?? 'http://127.0.0.1:4446', settings: { requestConcurrency: 1, ...options.settings } })
  }
}

const CHAIN_CLIENTS = {
  10: OPChain,
  130: UniChain,
  252: FraxtalChain,
  1135: LiskChain,
  1868: SoneiumChain,
  5330: SuperseedChain,
  8453: BaseChain,
  34443: ModeChain,
  42220: CeloChain,
  57073: InkChain,
} as const

export function getChain(chainId: ChainId | number, options: SugarClientOptions = {}): SugarClient {
  if (!isSupportedChainId(chainId)) throw new Error(`Unsupported chain ID: ${chainId}`)
  const ChainClient = CHAIN_CLIENTS[chainId]
  return new ChainClient(options)
}

export function getSimnetChain(chainId: ChainId | number, options: SugarClientOptions = {}): LiskChainSimnet | UniChainSimnet {
  if (chainId === 1135) return new LiskChainSimnet(options)
  if (chainId === 130) return new UniChainSimnet(options)
  throw new Error(`Unsupported simnet chain ID: ${chainId} (supported: 130, 1135)`)
}

export function getChainFromToken(token: Token, options: SugarClientOptions = {}): SugarClient {
  return getChain(token.chainId, options)
}

export function getSimnetChainFromToken(token: Token, options: SugarClientOptions = {}): LiskChainSimnet | UniChainSimnet {
  return getSimnetChain(token.chainId, options)
}

// TypeScript clients are asynchronous by design. These aliases preserve the
// Python SDK's discoverable async factory/class names during migration.
export const getAsyncChain = getChain
export const getAsyncSimnetChain = getSimnetChain
export const getAsyncChainFromToken = getChainFromToken
export const getAsyncSimnetChainFromToken = getSimnetChainFromToken
export {
  OPChain as AsyncOPChain,
  BaseChain as AsyncBaseChain,
  UniChain as AsyncUniChain,
  LiskChain as AsyncLiskChain,
  ModeChain as AsyncModeChain,
  FraxtalChain as AsyncFraxtalChain,
  InkChain as AsyncInkChain,
  SoneiumChain as AsyncSoneiumChain,
  SuperseedChain as AsyncSuperseedChain,
  CeloChain as AsyncCeloChain,
  LiskChainSimnet as AsyncLiskChainSimnet,
  UniChainSimnet as AsyncUniChainSimnet,
}
