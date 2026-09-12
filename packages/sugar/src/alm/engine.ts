import { encodeFunctionData, type Address, type Hex, type PublicClient } from 'viem'
import { abis } from '../abis'
import { SugarClient } from '../client'
import { addressKey, applySlippage, futureTimestamp, normalizeAddress, tickToPrice, tokenToNumber, parseTokenUnits } from '../helpers'
import { withdrawalFromPosition } from '../models'
import { createFileJournalStore } from '../execution-journal'
import { createExecutionPlan, sendPlan, type PlanJournalStore, type PlanSigner, type PlanStep } from '../send'
import { ADDRESS_ZERO, type LiquidityPool, type Position, type Token, type UnsignedTransaction } from '../types'
import { averageTick, checkTwapGate, pushTickSample, readPoolTick, readTwapTick, type TickHistory } from './chain'
import { strategySettingsFor, type AlmConfig, type AlmPositionConfig } from './config'
import { compoundNotification, errorNotification, noopNotifier, rebalanceNotification, type AlmNotifier } from './notify'
import { planRangeSwap, token0ValueShare } from './rebalance'
import { assertSafeAlmSupported, wrapWithRole } from './roles'
import { reconcileAlmCycle } from './recovery'
import { buildSafeDeposit, buildSafeWithdraw } from './safe-builders'
import { simulatePlan } from './simulate'
import { acquireAlmStateLock, checkRebalanceGate, loadAlmState, managedPositionId, positionStateKey, recordCompound, recordRebalance, saveAlmState, type AlmCycle, type AlmState } from './state'
import { decideRange, type RangeDecision } from './strategy'

/**
 * The self-hosted ALM engine behind `aero serve`.
 *
 * Each pass polls every configured pool's tick directly (one eth_call), runs
 * the Pulse strategy decision against the cached position, and — when a
 * rebalance is due and every gate agrees (cooldown, daily cap, TWAP
 * deviation) — executes the cycle in phases, each built from fresh chain
 * state and simulated via eth_simulateV1 before signing:
 *
 *   claim emissions -> unstake -> withdraw (burn) -> swap to the new ratio
 *   -> deposit into the new interval -> stake
 *
 * In dry-run mode (the default) the engine reports what it would do and
 * never signs anything.
 */

const SNAPSHOT_TTL_MS = 15 * 60_000
const COMPOUND_MIN_INTERVAL_MS = 24 * 60 * 60_000

export type EngineOptions = {
  config: AlmConfig
  /**
   * Wallet under management: the position owner. In Safe mode this is the
   * Safe (avatar); the signer below is then the low-privilege keeper key.
   */
  wallet: Address
  /** Present only in execute mode; dry-run engines never sign. */
  signer?: PlanSigner
  /**
   * Safe mode: execute every plan through a Zodiac Roles Modifier attached
   * to the Safe at `wallet`. Disables native-leg handling and compounding.
   */
  safe?: { rolesModifier: Address; roleKey: Hex }
  /** Refuse to broadcast when the RPC cannot simulate first (default true). */
  requireSimulation?: boolean
  rpcUrl?: string
  log?: (line: string) => void
  notifier?: AlmNotifier
  now?: () => number
  statePath?: string
  journalStore?: PlanJournalStore
  /** Test hooks. */
  clientFactory?: (chainId: number) => SugarClient
  publicClient?: PublicClient
}

type PositionRuntime = {
  config: AlmPositionConfig
  history: TickHistory
  snapshot?: { position: Position; fetchedAt: number }
  /** Dry-run/notification dedupe: last intent that was already reported. */
  lastReportedIntent?: string
  lastErrorMessage?: string
}

function toPlanSteps(transactions: UnsignedTransaction[]): PlanStep[] {
  return transactions.map((transaction, index) => ({
    role: index === transactions.length - 1 ? 'action' as const : 'approval' as const,
    transaction,
  }))
}

function rangeLabel(tickLower: number, tickUpper: number): string {
  return `[${tickLower}, ${tickUpper})`
}

export class AlmEngine {
  private readonly options: EngineOptions
  private readonly positions: PositionRuntime[]
  private readonly publicClient: PublicClient
  private readonly notifier: AlmNotifier
  private readonly log: (line: string) => void
  private readonly now: () => number
  private state: AlmState
  private readonly journalStore: PlanJournalStore

  constructor(options: EngineOptions) {
    if (options.signer && (options.safe || options.config.safe)) assertSafeAlmSupported()
    if (options.signer && normalizeAddress(options.signer.address) !== normalizeAddress(options.wallet)) throw new Error('ALM signer must match the managed wallet')
    this.journalStore = options.journalStore ?? createFileJournalStore()
    this.options = options
    this.positions = options.config.positions.map((config) => ({ config, history: { samples: [] } }))
    this.publicClient = options.publicClient
      ?? new SugarClient(options.config.chain, { rpcUrl: options.rpcUrl }).publicClient
    this.notifier = options.notifier ?? noopNotifier()
    this.log = options.log ?? console.log
    this.now = options.now ?? Date.now
    this.state = loadAlmState(options.statePath)
  }

  get executing(): boolean {
    return this.options.signer !== undefined
  }

  private newClient(): SugarClient {
    const factory = this.options.clientFactory
    if (factory) return factory(this.options.config.chain)
    return new SugarClient(this.options.config.chain, {
      rpcUrl: this.options.rpcUrl,
      account: this.options.wallet,
      publicClient: this.options.publicClient,
    })
  }

  /** One full poll over every configured position. Never throws. */
  async runPass(): Promise<void> {
    let release: (() => void) | undefined
    try {
      if (this.executing) release = acquireAlmStateLock(this.options.statePath)
      this.state = loadAlmState(this.options.statePath)
      if (this.executing && await this.publicClient.getChainId() !== this.options.config.chain) throw new Error('ALM RPC chain differs from configured chain')
      const pending = Object.values(this.state).flatMap((entry) => entry.cycle?.status.kind === 'active' ? [entry.cycle] : [])
        .filter((cycle) => cycle.chain === this.options.config.chain && addressKey(cycle.wallet) === addressKey(this.options.wallet))
      if (pending.length > 0) {
        for (const cycle of pending) {
          if (this.executing) await reconcileAlmCycle(cycle, this.journalStore, this.publicClient)
          this.log(`ALM cycle ${cycle.id} requires manual recovery; run aero alm recover --id ${cycle.id}. No new cycle will start.`)
        }
        return
      }
      await this.runUnlockedPass()
    } catch (cause) {
      this.log(`ALM pass blocked: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      release?.()
    }
  }

  private async runUnlockedPass(): Promise<void> {
    for (const runtime of this.positions) {
      try {
        await this.runPositionPass(runtime)
        runtime.lastErrorMessage = undefined
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        this.log(`[${runtime.config.pool}] pass failed: ${message}`)
        if (runtime.lastErrorMessage !== message) {
          runtime.lastErrorMessage = message
          await this.notifier(errorNotification({
            poolSymbol: runtime.snapshot?.position.pool.symbol ?? runtime.config.pool,
            phase: 'pass',
            message,
          }))
        }
        runtime.snapshot = undefined
        if (this.executing) return
      }
    }
  }

  private async runPositionPass(runtime: PositionRuntime): Promise<void> {
    const { config } = runtime
    const now = this.now()
    const spot = await readPoolTick(this.publicClient, config.pool)
    pushTickSample(runtime.history, spot.tick, now, config.twapSeconds * 2_000)

    const snapshot = await this.ensureSnapshot(runtime)
    if (snapshot === undefined) {
      this.log(`[${config.pool}] no CL position found for ${this.options.wallet}; waiting`)
      return
    }
    const position = snapshot.position
    const tickSpacing = position.pool.type
    const settings = strategySettingsFor(config, tickSpacing, position.tickUpper - position.tickLower)
    const decision = decideRange(
      { tick: spot.tick, tickSpacing, tickLower: position.tickLower, tickUpper: position.tickUpper },
      settings,
    )

    if (decision.action === 'hold') {
      runtime.lastReportedIntent = undefined
      await this.maybeCompound(runtime, spot.tick)
      return
    }

    const label = `${position.pool.symbol} ${rangeLabel(position.tickLower, position.tickUpper)} -> ${rangeLabel(decision.tickLower, decision.tickUpper)}`
    const gate = checkRebalanceGate(
      this.positionState(runtime),
      now,
      config.cooldownMinutes,
      config.maxRebalancesPerDay,
    )
    if (!gate.allowed) {
      this.log(`[${position.pool.symbol}] rebalance wanted (${decision.reason}) but ${gate.reason}`)
      return
    }
    const twapTick = await readTwapTick(this.publicClient, config.pool, config.twapSeconds)
      ?? averageTick(runtime.history, config.twapSeconds * 1_000, now, this.options.config.pollSeconds * 2_000)
    const twapGate = checkTwapGate(spot.tick, twapTick, config.maxTwapDeviationTicks)
    if (!twapGate.allowed) {
      this.log(`[${position.pool.symbol}] rebalance wanted (${decision.reason}) but ${twapGate.reason}`)
      return
    }

    if (!this.executing) {
      await this.reportDryRun(runtime, position, decision, spot.tick)
      return
    }

    this.log(`[${position.pool.symbol}] rebalancing: ${decision.reason}`)
    this.beginCycle(runtime, 'rebalance', position, decision)
    const hashes = await this.executeRebalance(runtime, decision)
    this.updateCycle(runtime, { status: { kind: 'complete' } })
    runtime.snapshot = undefined
    await this.notifier(rebalanceNotification({
      dryRun: false,
      poolSymbol: position.pool.symbol,
      chainName: position.chainName,
      strategy: settings.strategy,
      reason: decision.reason,
      oldRange: rangeLabel(position.tickLower, position.tickUpper),
      newRange: rangeLabel(decision.tickLower, decision.tickUpper),
      hashes,
    }))
    this.log(`[${position.pool.symbol}] rebalanced: ${label} (${hashes.length} txs)`)
  }

  private async ensureSnapshot(runtime: PositionRuntime): Promise<PositionRuntime['snapshot']> {
    const now = this.now()
    if (!this.executing && runtime.snapshot && now - runtime.snapshot.fetchedAt < SNAPSHOT_TTL_MS) return runtime.snapshot
    const selectedId = managedPositionId(this.positionState(runtime), runtime.config.positionId)
    const client = this.newClient()
    const position = selectedId === undefined
      ? await client.getPositionByPool(runtime.config.pool, this.options.wallet)
      : await client.getPositionById(selectedId, this.options.wallet, runtime.config.pool)
    if (!position || !position.pool.isCl) {
      runtime.snapshot = undefined
      return undefined
    }
    if (position.isAlm) throw new Error('position is managed by an on-chain ALM already; remove it from the config')
    runtime.snapshot = { position, fetchedAt: now }
    return runtime.snapshot
  }

  private async reportDryRun(
    runtime: PositionRuntime,
    position: Position,
    decision: Extract<RangeDecision, { action: 'rebalance' }>,
    tick: number,
  ): Promise<void> {
    const intent = `${decision.tickLower}:${decision.tickUpper}`
    const pool = position.pool
    const amount0 = tokenToNumber(pool.token0, position.amountToken0 + position.stakedToken0)
    const amount1 = tokenToNumber(pool.token1, position.amountToken1 + position.stakedToken1)
    const price = tickToPrice(tick, pool.token0.decimals, pool.token1.decimals)
    const swap = planRangeSwap({
      tick,
      tickLower: decision.tickLower,
      tickUpper: decision.tickUpper,
      price,
      amount0Decimal: amount0,
      amount1Decimal: amount1,
    })
    const swapNote = swap.direction === 'none'
      ? 'no swap needed'
      : swap.direction === '0->1'
        ? `swap ~${swap.amountDecimal.toFixed(6)} ${pool.token0.symbol} -> ${pool.token1.symbol}`
        : `swap ~${swap.amountDecimal.toFixed(6)} ${pool.token1.symbol} -> ${pool.token0.symbol}`
    this.log(`[${pool.symbol}] DRY-RUN would rebalance: ${decision.reason}`)
    this.log(`[${pool.symbol}] DRY-RUN plan: ${position.staked > 0n ? 'unstake -> ' : ''}withdraw+burn -> ${swapNote} -> deposit ${rangeLabel(decision.tickLower, decision.tickUpper)}${pool.gaugeAlive ? ' -> stake' : ''}`)
    if (runtime.lastReportedIntent === intent) return
    runtime.lastReportedIntent = intent
    await this.notifier(rebalanceNotification({
      dryRun: true,
      poolSymbol: pool.symbol,
      chainName: position.chainName,
      strategy: strategySettingsFor(runtime.config, pool.type, position.tickUpper - position.tickLower).strategy,
      reason: decision.reason,
      oldRange: rangeLabel(position.tickLower, position.tickUpper),
      newRange: rangeLabel(decision.tickLower, decision.tickUpper),
    }))
  }

  // --- execution ---

  private stateKey(runtime: PositionRuntime): string {
    return positionStateKey(this.options.config.chain, runtime.config.pool, this.options.wallet)
  }

  private positionId(runtime: PositionRuntime): bigint {
    const cycle = this.state[this.stateKey(runtime)]?.cycle
    if (!cycle || cycle.status.kind !== 'active') throw new Error('No active ALM position identity')
    return BigInt(cycle.positionId)
  }

  private positionState(runtime: PositionRuntime) {
    return this.state[this.stateKey(runtime)] ?? this.state[positionStateKey(this.options.config.chain, runtime.config.pool)]
  }

  private beginCycle(runtime: PositionRuntime, kind: AlmCycle['kind'], position: Position, interval: { tickLower: number; tickUpper: number }): void {
    const key = this.stateKey(runtime)
    const startedAt = this.now()
    const entry = this.positionState(runtime) ?? { rebalances: [] }
    if (entry.cycle?.status.kind === 'active') throw new Error('ALM cycle requires recovery')
    this.state = { ...this.state, [key]: { ...entry,
      configuredPositionId: runtime.config.positionId?.toString(), managedPositionId: position.id.toString(), cycle: {
      id: crypto.randomUUID(), kind, chain: this.options.config.chain, wallet: this.options.wallet,
      pool: runtime.config.pool, positionId: position.id.toString(), tickLower: interval.tickLower, tickUpper: interval.tickUpper, startedAt,
      balances: {}, phases: [], status: { kind: 'active' },
    } } }
    this.state = kind === 'rebalance' ? recordRebalance(this.state, key, startedAt) : recordCompound(this.state, key, startedAt)
    saveAlmState(this.state, this.options.statePath)
  }

  private updateCycle(runtime: PositionRuntime, update: Partial<Pick<AlmCycle, 'balances' | 'phases' | 'status' | 'resultPositionId'>>): AlmCycle {
    const key = this.stateKey(runtime)
    const entry = this.state[key]
    if (!entry?.cycle || entry.cycle.status.kind !== 'active') throw new Error('No active ALM cycle')
    const cycle = { ...entry.cycle, ...update }
    this.state = { ...this.state, [key]: { ...entry, cycle,
      managedPositionId: cycle.status.kind === 'complete' ? cycle.resultPositionId ?? cycle.positionId : entry.managedPositionId,
    } }
    saveAlmState(this.state, this.options.statePath)
    return cycle
  }

  private async guardedTick(runtime: PositionRuntime): Promise<number> {
    const config = runtime.config
    const tick = (await readPoolTick(this.publicClient, config.pool)).tick
    const now = this.now()
    pushTickSample(runtime.history, tick, now, config.twapSeconds * 2_000)
    const twap = await readTwapTick(this.publicClient, config.pool, config.twapSeconds)
      ?? averageTick(runtime.history, config.twapSeconds * 1_000, now, this.options.config.pollSeconds * 2_000)
    const gate = checkTwapGate(tick, twap, config.maxTwapDeviationTicks)
    if (!gate.allowed) throw new Error(gate.reason)
    return tick
  }

  private async sendPhase(runtime: PositionRuntime, phase: string, poolSymbol: string, rawSteps: PlanStep[]): Promise<Hex[]> {
    const signer = this.options.signer
    if (!signer) throw new Error('sendPhase called without a signer')
    if (rawSteps.length === 0) return []
    // Safe mode: the keeper executes each planned Safe transaction through
    // the Roles Modifier, which enforces the scoped permissions on-chain.
    const safe = this.options.safe
    const steps = safe
      ? rawSteps.map((step) => ({ ...step, transaction: wrapWithRole(step.transaction, signer.address, safe.rolesModifier, safe.roleKey) }))
      : rawSteps
    const simulation = await simulatePlan(this.publicClient, safe ? signer.address : this.options.wallet, steps)
    if (simulation.outcome === 'revert') {
      throw new Error(`${phase} simulation reverted at step ${simulation.step + 1}/${steps.length} (${simulation.role}): ${simulation.reason}`)
    }
    if (simulation.outcome === 'unsupported') {
      if (this.options.requireSimulation ?? true) {
        throw new Error(`${phase}: ${simulation.reason}. Use an RPC with eth_simulateV1 (e.g. Alchemy) or pass --allow-unsimulated.`)
      }
      this.log(`[${poolSymbol}] WARNING: ${phase} not simulated (${simulation.reason})`)
    }
    await this.guardedTick(runtime)
    const plan = createExecutionPlan({ steps, chainId: this.options.config.chain, sender: signer.address })
    const cycle = this.state[this.stateKey(runtime)]?.cycle
    if (!cycle) throw new Error('No ALM cycle to journal')
    this.updateCycle(runtime, { phases: [...cycle.phases, { name: phase, executionId: plan.id }] })
    this.journalStore.save({ plan, status: 'active', steps: steps.map(() => ({ kind: 'ready' })) })
    this.log(`[${poolSymbol}] ${phase}: sending ${steps.length} tx(s)`)
    const hashes = await sendPlan({
      plan,
      signer,
      store: this.journalStore,
      beforeSend: async () => { await this.guardedTick(runtime) },
      rpcUrl: this.options.rpcUrl,
      publicClient: this.publicClient,
      log: (line) => this.log(`[${poolSymbol}] ${line}`),
    })
    runtime.snapshot = undefined
    return hashes
  }

  private isNativeLeg(client: SugarClient, token: Token): boolean {
    // Safe mode is strictly ERC20: WETH legs stay WETH so no plan ever
    // carries ether (the role forbids Send).
    if (this.options.safe) return false
    return token.wrappedTokenAddress !== undefined
      && addressKey(token.wrappedTokenAddress) === addressKey(client.settings.wrappedNativeTokenAddress)
  }

  /** The tradable token for a pool leg: the native pseudo-token for wrapped-native legs. */
  private async legToken(client: SugarClient, token: Token): Promise<Token> {
    if (!this.isNativeLeg(client, token)) return token
    const native = await client.getToken(client.settings.nativeTokenSymbol)
    if (!native) throw new Error(`native token ${client.settings.nativeTokenSymbol} not found`)
    return native
  }

  private async legBalance(client: SugarClient, token: Token): Promise<bigint> {
    if (this.isNativeLeg(client, token)) return this.publicClient.getBalance({ address: this.options.wallet })
    return client.balanceOf(normalizeAddress(token.tokenAddress), this.options.wallet)
  }

  private async executeRebalance(
    runtime: PositionRuntime,
    decision: Extract<RangeDecision, { action: 'rebalance' }>,
  ): Promise<string[]> {
    const config = runtime.config
    const hashes: string[] = []
    let client = this.newClient()
    let position = await client.getPositionById(this.positionId(runtime), this.options.wallet, config.pool)
    if (!position) throw new Error('position disappeared before rebalancing')
    const previousIds = new Set((await client.getPositionsByPool(config.pool, this.options.wallet)).map((entry) => entry.id))
    const pool = position.pool
    const wasStaked = position.staked > 0n

    // Phase 1: claim pending emissions so they are not left behind on the gauge.
    if (wasStaked && position.emissionsEarned > 0n) {
      hashes.push(...await this.sendPhase(runtime, 'claim emissions', pool.symbol, toPlanSteps(await client.claimEmissions(position))))
    }

    // Phase 2: unstake the NFT out of the gauge.
    if (wasStaked) {
      hashes.push(...await this.sendPhase(runtime, 'unstake', pool.symbol, toPlanSteps(await client.unstake(position))))
      client = this.newClient()
      position = await client.getPositionById(this.positionId(runtime), this.options.wallet, config.pool)
      if (!position) throw new Error('position disappeared after unstaking')
    }
    if (position.liquidity === 0n) throw new Error('position has no liquidity to withdraw')

    // Phase 3: withdraw everything, collect fees, burn the emptied NFT.
    // Safe mode avoids NFPM.multicall so the role's per-selector conditions apply.
    const hasNativeLeg = this.isNativeLeg(client, pool.token0) || this.isNativeLeg(client, pool.token1)
    const baseline0 = await this.legBalance(client, pool.token0)
    const baseline1 = await this.legBalance(client, pool.token1)
    this.updateCycle(runtime, { balances: { token0: baseline0.toString(), token1: baseline1.toString() } })
    const withdrawPlan = this.options.safe
      ? buildSafeWithdraw(this.options.wallet, position, config.slippage)
      : await client.withdraw(withdrawalFromPosition(position, { burn: true }), 30, config.slippage, true, hasNativeLeg)
    hashes.push(...await this.sendPhase(runtime, 'withdraw', pool.symbol, toPlanSteps(withdrawPlan)))

    // Phase 4: swap the surplus side so holdings match the new interval ratio.
    client = this.newClient()
    const freshTick = await this.guardedTick(runtime)
    const available = async () => {
      const [now0, now1] = [await this.legBalance(client, pool.token0), await this.legBalance(client, pool.token1)]
      return {
        amount0: now0 > baseline0 ? now0 - baseline0 : 0n,
        amount1: now1 > baseline1 ? now1 - baseline1 : 0n,
      }
    }
    const afterWithdraw = await available()
    const price = tickToPrice(freshTick, pool.token0.decimals, pool.token1.decimals)
    const swap = planRangeSwap({
      tick: freshTick,
      tickLower: decision.tickLower,
      tickUpper: decision.tickUpper,
      price,
      amount0Decimal: tokenToNumber(pool.token0, afterWithdraw.amount0),
      amount1Decimal: tokenToNumber(pool.token1, afterWithdraw.amount1),
    })
    if (swap.direction !== 'none') {
      const fromLeg = swap.direction === '0->1' ? pool.token0 : pool.token1
      const toLeg = swap.direction === '0->1' ? pool.token1 : pool.token0
      const fromToken = await this.legToken(client, fromLeg)
      const toToken = await this.legToken(client, toLeg)
      const rawIn = parseTokenUnits(fromLeg, swap.amountDecimal.toFixed(Math.min(fromLeg.decimals, 12)))
      const capped = swap.direction === '0->1'
        ? (rawIn > afterWithdraw.amount0 ? afterWithdraw.amount0 : rawIn)
        : (rawIn > afterWithdraw.amount1 ? afterWithdraw.amount1 : rawIn)
      if (capped > 0n) {
        hashes.push(...await this.sendPhase(runtime,
          `swap ${fromLeg.symbol} -> ${toLeg.symbol}`,
          pool.symbol,
          toPlanSteps(await client.swap(fromToken, toToken, capped, config.swapSlippage)),
        ))
      }
    }

    // Phase 5: deposit into the new interval.
    client = this.newClient()
    const freshPool = await client.getPoolByAddress(config.pool)
    if (!freshPool) throw new Error('pool vanished from the catalog')
    const funds = await available()
    hashes.push(...await this.sendPhase(runtime,
      'deposit',
      pool.symbol,
      toPlanSteps(await this.buildDeposit(client, freshPool, decision, funds, config.slippage)),
    ))

    // Phase 6: stake the new position when the gauge is live.
    client = this.newClient()
    const candidates = (await client.getPositionsByPool(config.pool, this.options.wallet)).filter((entry) => !previousIds.has(entry.id))
    const minted = candidates.length === 1 ? candidates[0] : undefined
    if (!minted || minted.id === this.positionId(runtime) || minted.tickLower !== decision.tickLower || minted.tickUpper !== decision.tickUpper || minted.staked !== 0n || minted.liquidity === 0n) {
      throw new Error('Could not identify the freshly minted position; inspect the cycle and recover manually')
    }
    this.updateCycle(runtime, { resultPositionId: minted.id.toString() })
    if (freshPool.gaugeAlive && freshPool.gauge !== ADDRESS_ZERO) {
      hashes.push(...await this.sendPhase(runtime, 'stake', pool.symbol, toPlanSteps(await client.stake(minted))))
    }
    return hashes
  }

  private async buildDeposit(
    client: SugarClient,
    pool: LiquidityPool,
    interval: { tickLower: number; tickUpper: number },
    funds: { amount0: bigint; amount1: bigint },
    slippage: number,
  ): Promise<UnsignedTransaction[]> {
    const share0 = token0ValueShare(pool.tick, interval.tickLower, interval.tickUpper)
    const quoteBy0 = share0 > 0 && funds.amount0 > 0n
    let quote = await client.quoteConcentratedDeposit(pool, {
      tickLower: interval.tickLower,
      tickUpper: interval.tickUpper,
      ...(quoteBy0 ? { amountToken0: funds.amount0 } : { amountToken1: funds.amount1 }),
    })
    if (quote.amountToken1 > funds.amount1 || quote.amountToken0 > funds.amount0) {
      // The other side is the binding constraint; requote from it.
      quote = await client.quoteConcentratedDeposit(pool, {
        tickLower: interval.tickLower,
        tickUpper: interval.tickUpper,
        ...(quoteBy0 ? { amountToken1: funds.amount1 } : { amountToken0: funds.amount0 }),
      })
    }
    if (quote.amountToken0 > funds.amount0 || quote.amountToken1 > funds.amount1) {
      throw new Error('deposit quote exceeds available funds on both sides; aborting')
    }
    if (quote.amountToken0 === 0n && quote.amountToken1 === 0n) throw new Error('deposit amounts are dust; aborting')
    if (this.options.safe) return buildSafeDeposit(client, this.options.wallet, quote, slippage)
    return client.deposit(quote, 30, slippage)
  }

  // --- compounding ---

  private async maybeCompound(runtime: PositionRuntime, tick: number): Promise<void> {
    const config = runtime.config
    if (!config.compound) return
    // The keeper role does not include increaseLiquidity (its tokenId cannot
    // be pinned), so Safe mode lets emissions accrue in the Safe instead.
    if (this.options.safe) return
    const snapshot = runtime.snapshot
    if (!snapshot) return
    const position = snapshot.position
    if (position.staked === 0n) return
    const emissionsToken = position.pool.emissionsToken
    if (!emissionsToken) return
    const earnedDecimal = tokenToNumber(emissionsToken, position.emissionsEarned)
    if (earnedDecimal < config.minCompoundEmissionsDecimal) return
    const lastCompoundAt = this.positionState(runtime)?.lastCompoundAt
    const now = this.now()
    if (lastCompoundAt !== undefined && now - lastCompoundAt < COMPOUND_MIN_INTERVAL_MS) return
    tick = await this.guardedTick(runtime)

    if (!this.executing) {
      const intent = `compound:${position.emissionsEarned}`
      this.log(`[${position.pool.symbol}] DRY-RUN would compound ${earnedDecimal.toFixed(4)} ${emissionsToken.symbol} into the position`)
      if (runtime.lastReportedIntent === intent) return
      runtime.lastReportedIntent = intent
      await this.notifier(compoundNotification({ dryRun: true, poolSymbol: position.pool.symbol, amountDecimal: earnedDecimal, symbol: emissionsToken.symbol }))
      return
    }

    this.log(`[${position.pool.symbol}] compounding ${earnedDecimal.toFixed(4)} ${emissionsToken.symbol}`)
    this.beginCycle(runtime, 'compound', position, position)
    const hashes = await this.executeCompound(runtime, tick)
    this.updateCycle(runtime, { status: { kind: 'complete' } })
    runtime.snapshot = undefined
    await this.notifier(compoundNotification({ dryRun: false, poolSymbol: position.pool.symbol, amountDecimal: earnedDecimal, symbol: emissionsToken.symbol, hashes }))
  }

  private async executeCompound(runtime: PositionRuntime, tick: number): Promise<string[]> {
    const config = runtime.config
    const hashes: string[] = []
    let client = this.newClient()
    let position = await client.getPositionById(this.positionId(runtime), this.options.wallet, config.pool)
    if (!position || position.staked === 0n) throw new Error('staked position disappeared before compounding')
    const pool = position.pool
    const emissionsToken = pool.emissionsToken
    if (!emissionsToken) throw new Error('pool has no emissions token')

    const baseline0 = await this.legBalance(client, pool.token0)
    const baseline1 = await this.legBalance(client, pool.token1)
    const emissionsBaseline = await client.balanceOf(normalizeAddress(emissionsToken.tokenAddress), this.options.wallet)
    this.updateCycle(runtime, { balances: { token0: baseline0.toString(), token1: baseline1.toString(), emissions: emissionsBaseline.toString() } })

    // Phase 1: claim the emissions from the gauge.
    hashes.push(...await this.sendPhase(runtime, 'claim emissions', pool.symbol, toPlanSteps(await client.claimEmissions(position))))
    client = this.newClient()
    const claimedTotal = await client.balanceOf(normalizeAddress(emissionsToken.tokenAddress), this.options.wallet) - emissionsBaseline
    if (claimedTotal <= 0n) throw new Error('no emissions arrived after claiming')

    // Phase 2: swap the claimed emissions into the pool legs by value share.
    tick = await this.guardedTick(runtime)
    const share0 = token0ValueShare(tick, position.tickLower, position.tickUpper)
    const toLeg0 = claimedTotal * BigInt(Math.floor(share0 * 1_000_000_000)) / 1_000_000_000n
    const toLeg1 = claimedTotal - toLeg0
    for (const [legRaw, leg] of [[toLeg0, pool.token0], [toLeg1, pool.token1]] as const) {
      if (legRaw <= 0n) continue
      if (addressKey(emissionsToken.tokenAddress) === addressKey(leg.tokenAddress)) continue
      const toToken = await this.legToken(client, leg)
      hashes.push(...await this.sendPhase(runtime,
        `swap ${emissionsToken.symbol} -> ${leg.symbol}`,
        pool.symbol,
        toPlanSteps(await client.swap(emissionsToken, toToken, legRaw, config.swapSlippage)),
      ))
    }

    // Phase 3: unstake, add the liquidity to the same interval, restake.
    client = this.newClient()
    position = await client.getPositionById(this.positionId(runtime), this.options.wallet, config.pool)
    if (!position) throw new Error('position disappeared while compounding')
    hashes.push(...await this.sendPhase(runtime, 'unstake', pool.symbol, toPlanSteps(await client.unstake(position))))

    client = this.newClient()
    const funds = {
      amount0: (await this.legBalance(client, pool.token0)) - baseline0,
      amount1: (await this.legBalance(client, pool.token1)) - baseline1,
    }
    if (funds.amount0 < 0n) funds.amount0 = 0n
    if (funds.amount1 < 0n) funds.amount1 = 0n
    const freshPool = await client.getPoolByAddress(config.pool)
    if (!freshPool) throw new Error('pool vanished from the catalog')
    hashes.push(...await this.sendPhase(runtime,
      'increase liquidity',
      pool.symbol,
      toPlanSteps(await this.buildIncreaseLiquidity(client, freshPool, position, funds, config.slippage)),
    ))

    client = this.newClient()
    const restaked = await client.getPositionById(this.positionId(runtime), this.options.wallet, config.pool)
    if (!restaked || restaked.staked !== 0n || restaked.liquidity === 0n) throw new Error('Could not identify the position to restake; manual recovery required')
    hashes.push(...await this.sendPhase(runtime, 'stake', pool.symbol, toPlanSteps(await client.stake(restaked))))
    return hashes
  }

  private async buildIncreaseLiquidity(
    client: SugarClient,
    pool: LiquidityPool,
    position: Position,
    funds: { amount0: bigint; amount1: bigint },
    slippage: number,
  ): Promise<UnsignedTransaction[]> {
    const share0 = token0ValueShare(pool.tick, position.tickLower, position.tickUpper)
    const quoteBy0 = share0 > 0 && funds.amount0 > 0n
    let quote = await client.quoteConcentratedDeposit(pool, {
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      ...(quoteBy0 ? { amountToken0: funds.amount0 } : { amountToken1: funds.amount1 }),
    })
    if (quote.amountToken1 > funds.amount1 || quote.amountToken0 > funds.amount0) {
      quote = await client.quoteConcentratedDeposit(pool, {
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        ...(quoteBy0 ? { amountToken1: funds.amount1 } : { amountToken0: funds.amount0 }),
      })
    }
    if (quote.amountToken0 > funds.amount0 || quote.amountToken1 > funds.amount1) {
      throw new Error('increase-liquidity quote exceeds the claimed funds; aborting')
    }
    if (quote.amountToken0 === 0n && quote.amountToken1 === 0n) throw new Error('nothing to compound after swaps')
    const native0 = this.isNativeLeg(client, pool.token0)
    const native1 = this.isNativeLeg(client, pool.token1)
    const approvals: UnsignedTransaction[] = []
    if (!native0 && quote.amountToken0 > 0n) {
      const approval = await client.setTokenAllowance(pool.token0, pool.nfpm, quote.amountToken0)
      if (approval) approvals.push(approval)
    }
    if (!native1 && quote.amountToken1 > 0n) {
      const approval = await client.setTokenAllowance(pool.token1, pool.nfpm, quote.amountToken1)
      if (approval) approvals.push(approval)
    }
    const params = [
      position.id,
      quote.amountToken0,
      quote.amountToken1,
      applySlippage(quote.amountToken0, slippage),
      applySlippage(quote.amountToken1, slippage),
      futureTimestamp(30),
    ] as const
    const increase = encodeFunctionData({ abi: abis.nfpm, functionName: 'increaseLiquidity', args: [params] })
    const data = native0 || native1
      ? encodeFunctionData({ abi: abis.nfpm, functionName: 'multicall', args: [[increase, encodeFunctionData({ abi: abis.nfpm, functionName: 'refundETH' })]] })
      : increase
    const value = native0 ? quote.amountToken0 : native1 ? quote.amountToken1 : 0n
    return [...approvals, { from: this.options.wallet, to: pool.nfpm, data, value }]
  }
}
