import { normalizeAddress } from '../helpers'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import * as Prompt from 'effect/unstable/cli/Prompt'
import { executeSugarActionEffect } from '../actions'
import { SugarClient } from '../client'
import { DEFAULT_CHAIN } from './flags'
import { isSugarTxAction, type SugarAction, type SugarParameters, type SugarTxAction } from '../contracts'
import { createExecutionPlan, extractPlanSteps, localMnemonicSigner, renderPlanSummary, sendPlan, type PlanSigner } from '../send'
import type { SugarJson } from '../types'
import { getActiveWallet, loadLocalWallet, loadWalletConnectRecord, openSecret } from '../wallet'
import { resolveTokenParameters } from './tokens'

export type BroadcastOptions = { yes: boolean; dryRun: boolean }

/** Bridge a CLI promise so a failure keeps its original identity at the edge. */
export function fromPromise<A>(evaluate: () => Promise<A>) {
  return Effect.tryPromise({ try: evaluate, catch: (cause) => cause })
}

/** Actions that read the connected wallet when --wallet is omitted. */
function acceptsWalletDefault(action: SugarAction): boolean {
  return isSugarTxAction(action) || action === 'positions' || action === 'stocks'
}

const printJson = (value: SugarJson) => Console.log(JSON.stringify(value, null, 2))

/** Run a read-only action and print its JSON result. */
export const runReadAction = Effect.fn('AeroCli.runReadAction')(function* (
  action: SugarAction,
  parameters: SugarParameters,
) {
  const active = parameters.wallet === undefined && parameters.owner === undefined && acceptsWalletDefault(action)
    ? getActiveWallet()
    : undefined
  const client = new SugarClient(Number(parameters.chain ?? DEFAULT_CHAIN), { account: parameters.wallet === undefined ? active?.address : normalizeAddress(String(parameters.wallet)) })
  const resolved = yield* resolveTokenParameters(action, parameters, { client })
  const withWallet = parameters.wallet === undefined && active && acceptsWalletDefault(action)
    ? { ...resolved, wallet: active.address }
    : resolved
  yield* printJson(yield* executeSugarActionEffect(action, withWallet, { clientFactory: () => client }))
})

export const resolveSigner = Effect.fn('AeroCli.resolveSigner')(function* () {
  const wc = loadWalletConnectRecord()
  if (wc) {
    const { walletConnectSendTransaction } = yield* Effect.promise(() => import('../walletconnect'))
    const signer: PlanSigner = {
      address: wc.address,
      describe: `WalletConnect (${wc.peer ?? 'wallet'})`,
      send: (transaction, chainId) => walletConnectSendTransaction(transaction, chainId, console.log),
    }
    return signer
  }
  const local = loadLocalWallet()
  if (!local) throw new Error('no wallet configured; run: aero wallet connect or aero wallet create')
  const passphrase = process.env.SUGAR_WALLET_PASSPHRASE
    ?? Redacted.value(yield* Prompt.password({ message: 'Wallet passphrase' }))
  return localMnemonicSigner(openSecret(local.sealed, passphrase))
})

/**
 * Run a transaction-building action. Without a matching connected wallet (or
 * with --dry-run) the unsigned plan is printed; otherwise the plan summary is
 * shown, the user confirms, and the plan is signed and broadcast step by step
 * (WalletConnect wallets approve each transaction in-app).
 */
export const runTxAction = Effect.fn('AeroCli.runTxAction')(function* (
  action: SugarTxAction,
  parameters: SugarParameters,
  options: BroadcastOptions,
) {
  const active = getActiveWallet()
  const client = new SugarClient(Number(parameters.chain ?? DEFAULT_CHAIN), { account: parameters.wallet === undefined ? active?.address : normalizeAddress(String(parameters.wallet)) })
  const resolved = yield* resolveTokenParameters(action, parameters, { client })
  const withWallet = parameters.wallet === undefined && active
    ? { ...resolved, wallet: active.address }
    : resolved
  const result = yield* executeSugarActionEffect(action, withWallet, { clientFactory: () => client })
  const walletMatches = active !== undefined
    && String(withWallet.wallet).toLowerCase() === active.address.toLowerCase()
  if (options.dryRun || !walletMatches) {
    yield* printJson(result)
    if (!options.dryRun && !active) {
      yield* Console.error('\nHint: connect a wallet to broadcast this plan (aero wallet connect).')
    }
    if (!options.dryRun && active && !walletMatches) {
      yield* Console.error(`\nHint: --wallet differs from the connected wallet (${active.address}); printed the unsigned plan instead.`)
    }
    return
  }
  const steps = extractPlanSteps(result)
  if (steps.length === 0) {
    yield* Console.log('Already balanced. No transactions needed.')
    return
  }
  const plan = createExecutionPlan({ steps, chainId: Number(withWallet.chain), sender: active.address })
  yield* Console.log(`Chain ${plan.chainId}, sender ${plan.sender}\n${renderPlanSummary(action, result, steps)}`)
  if (!options.yes) {
    if (!process.stdin.isTTY) throw new Error('no TTY for the confirmation prompt; pass --yes or --dry-run')
    const confirmed = yield* Prompt.confirm({ message: 'Sign and broadcast?' })
    if (!confirmed) {
      yield* Console.log('Aborted; nothing was sent.')
      return
    }
  }
  const chainId = Number(withWallet.chain)
  const signer = yield* resolveSigner()
  const hashes = yield* fromPromise(() => sendPlan({ plan, signer, log: console.log }))
  yield* printJson({ status: 'sent', chain: chainId, wallet: signer.address, hashes })
})
