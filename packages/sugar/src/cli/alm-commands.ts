import * as Console from 'effect/Console'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Schedule from 'effect/Schedule'
import * as Command from 'effect/unstable/cli/Command'
import * as Flag from 'effect/unstable/cli/Flag'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { encodeFunctionData, type Address } from 'viem'
import { abis } from '../abis'
import { AlmEngine } from '../alm/engine'
import { readPoolTick } from '../alm/chain'
import { almConfigPath, DEFAULT_ROLE_KEY, loadAlmConfig, saveAlmConfigFile, strategySettingsFor, type AlmConfigFile } from '../alm/config'
import { buddytgNotifier, noopNotifier } from '../alm/notify'
import {
  assertSafeAlmSupported,
  encodeRoleConfigCall,
  encodeRoleKey,
  keeperPermissionCalls,
  MODULE_PROXY_FACTORY,
  moduleProxyFactoryAbi,
  predictRolesModifierAddress,
  rolesAbi,
  rolesInitializer,
  ROLES_V2_MASTERCOPY,
  safeAbi,
} from '../alm/roles'
import { checkRebalanceGate, loadAlmState, managedPositionId, positionStateKey } from '../alm/state'
import { ALM_STRATEGIES } from '../alm/strategy'
import { SugarClient } from '../client'
import { normalizeAddress, tokenToNumber } from '../helpers'
import { localMnemonicSigner, type PlanSigner } from '../send'
import { ADDRESS_ZERO } from '../types'
import { getActiveWallet, loadLocalWallet, openSecret, promptLine } from '../wallet'
import { almRecoverCommand, almResolveCommand } from './alm-recovery-commands'
import * as flags from './flags'
import { optionalValue } from './flags'
import { fromPromise } from './run-action'

/**
 * `aero serve` — the self-hosted ALM daemon — plus the `aero alm` helpers
 * that scaffold and inspect its configuration. Dry-run is the default; only
 * `--execute` (with the local encrypted wallet unlocked at startup) signs.
 */

const configFlag = Flag.string('config').pipe(
  Flag.optional,
  Flag.withMetavar('<path>'),
  Flag.withDescription(`ALM config file (default ${almConfigPath()})`),
)

/** Unattended signing needs a local key; WalletConnect cannot approve in the background. */
const resolveLocalSigner = Effect.fn('AeroCli.resolveLocalSigner')(function* () {
  const local = loadLocalWallet()
  if (!local) {
    throw new Error('--execute needs the local encrypted wallet (aero wallet create / restore); WalletConnect cannot sign unattended')
  }
  const passphrase = process.env.SUGAR_WALLET_PASSPHRASE
    ?? (yield* fromPromise(() => promptLine('Wallet passphrase: ', true)))
  return localMnemonicSigner(openSecret(local.sealed, passphrase))
})

const serve = Command.make('serve', {
  config: configFlag,
  execute: Flag.boolean('execute').pipe(Flag.withDescription('Sign and broadcast rebalances (default: dry-run, print/notify only)')),
  once: Flag.boolean('once').pipe(Flag.withDescription('Run a single pass and exit (useful for cron and testing)')),
  interval: Flag.integer('interval').pipe(Flag.optional, Flag.withDescription('Override the poll interval in seconds')),
  allowUnsimulated: Flag.boolean('allow-unsimulated').pipe(Flag.withDescription('Broadcast even when the RPC cannot pre-simulate via eth_simulateV1')),
  wallet: flags.wallet,
}, Effect.fn(function* (config) {
  const almConfig = loadAlmConfig(optionalValue(config.config))
  const pollSeconds = optionalValue(config.interval) ?? almConfig.pollSeconds
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1) throw new Error('ALM poll interval must be at least one second')
  const safe = almConfig.safe
  if (config.execute && safe) assertSafeAlmSupported()
  let signer: PlanSigner | undefined
  let wallet: Address
  if (config.execute) {
    // In Safe mode the local wallet is the low-privilege keeper; the
    // observed wallet (position owner) is the Safe itself.
    signer = yield* resolveLocalSigner()
    wallet = safe ? safe.address : signer.address
  } else if (safe) {
    wallet = safe.address
  } else {
    const flagWallet = optionalValue(config.wallet)
    const active = getActiveWallet()
    if (flagWallet !== undefined) wallet = normalizeAddress(flagWallet)
    else if (active) wallet = active.address
    else throw new Error('dry-run needs a wallet: connect one (aero wallet connect/create) or pass --wallet')
  }
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`)
  const engine = new AlmEngine({
    config: { ...almConfig, pollSeconds },
    wallet,
    signer,
    safe: safe ? { rolesModifier: safe.rolesModifier, roleKey: encodeRoleKey(safe.roleKey) } : undefined,
    requireSimulation: !config.allowUnsimulated,
    log,
    notifier: almConfig.telegram ? buddytgNotifier((line) => log(line)) : noopNotifier(),
  })
  yield* Console.log([
    `aero serve — self-hosted ALM (${config.execute ? 'EXECUTE mode: will sign and broadcast' : 'dry-run: printing and notifying only'})`,
    `  chain ${almConfig.chain} | ${safe ? `Safe ${safe.address} via Roles ${safe.rolesModifier} (role "${safe.roleKey}", keeper ${signer?.address ?? 'n/a in dry-run'})` : `wallet ${wallet}`} | ${almConfig.positions.length} position(s) | poll every ${pollSeconds}s`,
    ...almConfig.positions.map((position) => `  - ${position.pool} (${position.strategy ?? 'original'})`),
    config.execute ? '' : '  Pass --execute once the dry-run output looks right.',
  ].filter(Boolean).join('\n'))
  const pass = fromPromise(() => engine.runPass())
  if (config.once) {
    yield* pass
    return
  }
  yield* pass.pipe(Effect.repeat(Schedule.spaced(Duration.seconds(pollSeconds))))
})).pipe(
  Command.withDescription('Watch your CL positions and auto-rebalance them like an ALM vault (dry-run by default)'),
  Command.withExamples([
    { command: 'aero alm init', description: 'Scaffold the config from your current CL positions first' },
    { command: 'aero serve', description: 'Dry-run: log and notify what would be rebalanced' },
    { command: 'aero serve --execute', description: 'Unlock the local wallet and actually rebalance' },
    { command: 'aero serve --once', description: 'Single pass (for cron)' },
  ]),
)

const init = Command.make('init', {
  chain: flags.chain,
  wallet: flags.wallet,
  positionId: Flag.string('position-id').pipe(Flag.optional, Flag.withDescription('Only configure this NFT, required when a pool has multiple positions')),
  strategy: Flag.choice('strategy', ALM_STRATEGIES).pipe(Flag.optional, Flag.withDescription('Strategy for every scaffolded position (default original)')),
  force: Flag.boolean('force').pipe(Flag.withDescription('Overwrite an existing config file')),
  config: configFlag,
}, Effect.fn(function* (config) {
  const path = optionalValue(config.config) ?? almConfigPath()
  if (existsSync(path) && !config.force) throw new Error(`${path} already exists; pass --force to overwrite`)
  const active = getActiveWallet()
  const wallet = optionalValue(config.wallet) ?? active?.address
  if (!wallet) throw new Error('no wallet: connect one (aero wallet connect/create) or pass --wallet')
  const client = new SugarClient(config.chain, { account: normalizeAddress(wallet) })
  const selectedId = optionalValue(config.positionId)
  if (selectedId !== undefined && !/^[1-9]\d*$/.test(selectedId)) throw new Error('position-id must be a positive NFT id')
  const positions = (yield* fromPromise(() => client.getPositions())).filter(
    (position) => position.pool.isCl && !position.isAlm && (position.liquidity > 0n || position.staked > 0n)
      && (selectedId === undefined || position.id === BigInt(selectedId)),
  )
  if (positions.length === 0) {
    yield* Console.log('No CL positions found to manage. Open one first (aero deposit --pool ... --tick-lower ... --tick-upper ...).')
    return
  }
  const strategy = optionalValue(config.strategy)
  if (new Set(positions.map((position) => position.pool.lp.toLowerCase())).size !== positions.length) {
    throw new Error('Multiple NFTs share a pool; pass --position-id to choose which position to manage')
  }
  const entries = positions.map((position) =>
    strategy === undefined ? { pool: position.pool.lp, positionId: position.id.toString() } : { pool: position.pool.lp, positionId: position.id.toString(), strategy },
  )
  const file: AlmConfigFile = { version: 1, chain: config.chain, positions: entries }
  saveAlmConfigFile(file, path)
  yield* Console.log([
    `Wrote ${path} with ${positions.length} position(s):`,
    ...positions.map((position) => `  - ${position.pool.symbol} ${position.pool.lp} [${position.tickLower}, ${position.tickUpper})`),
    '',
    'Defaults mirror the Mellow ALM production parameters; edit the file to tune',
    'strategy, widthTicks, cooldownMinutes, maxRebalancesPerDay, telegram, ...',
    'Then: aero serve (dry-run) and aero serve --execute when it looks right.',
  ].join('\n'))
})).pipe(Command.withDescription('Scaffold the ALM config from your current CL positions'))

/**
 * Generate the one-time Safe setup: deploy a Roles Modifier, enable it as a
 * module, assign the keeper, and scope the role to exactly the rebalance
 * moves. Output is a Safe Transaction Builder JSON batch the owner executes
 * with a single signature at app.safe.global.
 */
const safeSetup = Command.make('safe-setup', {
  safe: Flag.string('safe').pipe(Flag.withMetavar('<0x address>'), Flag.withDescription('The Safe that owns (or will own) the CL positions')),
  keeper: Flag.string('keeper').pipe(Flag.optional, Flag.withMetavar('<0x address>'), Flag.withDescription('Keeper address (defaults to the local encrypted wallet)')),
  role: Flag.string('role').pipe(Flag.withDefault(DEFAULT_ROLE_KEY), Flag.withDescription('Role name (bytes32-encoded on-chain)')),
  saltNonce: Flag.string('salt-nonce').pipe(Flag.withDefault('0'), Flag.withDescription('ModuleProxyFactory salt nonce (change to deploy a fresh modifier)')),
  out: Flag.string('out').pipe(Flag.optional, Flag.withMetavar('<path>'), Flag.withDescription('Output path for the Transaction Builder JSON (default ./aero-alm-safe-setup.json)')),
  config: configFlag,
}, Effect.fn(function* (config) {
  assertSafeAlmSupported()
  const configPath = optionalValue(config.config) ?? almConfigPath()
  const almConfig = loadAlmConfig(configPath)
  const safe = normalizeAddress(config.safe)
  const keeperFlag = optionalValue(config.keeper)
  const keeper = keeperFlag !== undefined ? normalizeAddress(keeperFlag) : loadLocalWallet()?.address
  if (!keeper) throw new Error('no keeper: create the local wallet (aero wallet create) or pass --keeper')
  const roleKey = encodeRoleKey(config.role)
  const saltNonce = BigInt(config.saltNonce)
  const client = new SugarClient(almConfig.chain, { account: safe })

  // Collect the exact contract surface the role may touch.
  const gauges: Address[] = []
  const tokens = new Set<Address>()
  const nfpms = new Set<Address>()
  for (const entry of almConfig.positions) {
    const pool = yield* fromPromise(() => client.getPoolByAddress(entry.pool))
    if (!pool) throw new Error(`pool ${entry.pool} not found in the catalog`)
    if (!pool.isCl) throw new Error(`pool ${pool.symbol} is not a CL pool; Safe mode manages CL positions only`)
    nfpms.add(pool.nfpm)
    if (pool.gauge && pool.gauge !== ADDRESS_ZERO) gauges.push(pool.gauge)
    tokens.add(normalizeAddress(pool.token0.tokenAddress))
    tokens.add(normalizeAddress(pool.token1.tokenAddress))
    if (pool.emissionsToken) tokens.add(normalizeAddress(pool.emissionsToken.tokenAddress))
  }
  if (nfpms.size !== 1) throw new Error(`expected one NFPM across pools, found ${nfpms.size}`)
  const [nfpm] = [...nfpms]
  const swapper = client.settings.swapperContractAddress
  const permit2 = yield* fromPromise(async () =>
    // SAFETY: the swapper ABI pins PERMIT2() to a single address return value.
    await client.publicClient.readContract({ address: swapper, abi: abis.swapper, functionName: 'PERMIT2' }) as Address)

  const rolesModifier = predictRolesModifierAddress(safe, saltNonce)
  const deployed = yield* fromPromise(async () =>
    (await client.publicClient.getCode({ address: rolesModifier }) ?? '0x') !== '0x')
  const enabled = deployed && (yield* fromPromise(async () =>
    // SAFETY: the Safe ABI pins isModuleEnabled to a single bool return value.
    await client.publicClient.readContract({ address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [rolesModifier] }) as boolean))

  const transactions: Array<{ to: Address; value: '0'; data: `0x${string}` }> = []
  if (!deployed) {
    transactions.push({
      to: MODULE_PROXY_FACTORY,
      value: '0',
      data: encodeFunctionData({ abi: moduleProxyFactoryAbi, functionName: 'deployModule', args: [ROLES_V2_MASTERCOPY, rolesInitializer(safe), saltNonce] }),
    })
  }
  if (!enabled) {
    transactions.push({ to: safe, value: '0', data: encodeFunctionData({ abi: safeAbi, functionName: 'enableModule', args: [rolesModifier] }) })
  }
  transactions.push({
    to: rolesModifier,
    value: '0',
    data: encodeFunctionData({ abi: rolesAbi, functionName: 'assignRoles', args: [keeper, [roleKey], [true]] }),
  })
  const permissions = keeperPermissionCalls({ nfpm, gauges, swapper, permit2, tokens: [...tokens] }, roleKey)
  transactions.push(...permissions.map((call) => encodeRoleConfigCall(rolesModifier, call)))

  const outPath = optionalValue(config.out) ?? 'aero-alm-safe-setup.json'
  const batch = {
    version: '1.0',
    chainId: String(almConfig.chain),
    createdAt: Date.now(),
    meta: {
      name: `aero ALM keeper role (${config.role})`,
      description: `Scoped Zodiac Roles v2 permissions letting keeper ${keeper} rebalance ${almConfig.positions.length} CL position(s); recipients pinned to the Safe`,
      txBuilderVersion: '1.16.5',
    },
    transactions: transactions.map((transaction) => ({ ...transaction, contractMethod: null, contractInputsValues: null })),
  }
  writeFileSync(outPath, `${JSON.stringify(batch, null, 2)}\n`)

  // Persist the Safe wiring so aero serve picks it up.
  // SAFETY: loadAlmConfig above already validated this file against the schema.
  const rawFile = JSON.parse(readFileSync(configPath, 'utf8')) as AlmConfigFile
  saveAlmConfigFile({ ...rawFile, safe: { address: safe, rolesModifier, roleKey: config.role } }, configPath)

  yield* Console.log([
    `Roles Modifier (predicted): ${rolesModifier}${deployed ? ' (already deployed)' : ''}`,
    `Keeper: ${keeper} | role "${config.role}" | ${transactions.length} setup transaction(s)`,
    `Wrote ${outPath} and updated ${configPath} with the safe section.`,
    '',
    'Next steps:',
    '  1. Open app.safe.global -> Transaction Builder -> import the JSON and',
    '     execute the batch (one signature from the Safe owners).',
    '  2. Move each CL position into the Safe: unstake it, then call',
    `     NFPM.safeTransferFrom(<current owner>, ${safe}, <position id>)`,
    '     from the current owner wallet (and keep a little ETH on the keeper for gas).',
    '  3. aero serve            (dry-run against the Safe)',
    '     aero serve --execute  (keeper signs through the Roles Modifier)',
    '',
    'The role can ONLY: mint/collect to the Safe, burn/decrease liquidity,',
    'approve the NFT to the pool gauges, stake/unstake/claim on those gauges,',
    'swap via the Aerodrome swapper, and approve ERC20s to the NFPM/Permit2.',
    'It cannot transfer funds or the NFT anywhere else, send ether, or delegatecall.',
  ].join('\n'))
})).pipe(Command.withDescription('Generate the one-time Safe + Zodiac Roles setup batch for unattended rebalancing'))

const status = Command.make('status', {
  config: configFlag,
  wallet: flags.wallet,
}, Effect.fn(function* (config) {
  const almConfig = loadAlmConfig(optionalValue(config.config))
  const active = getActiveWallet()
  const wallet = optionalValue(config.wallet) ?? almConfig.safe?.address ?? active?.address
  if (!wallet) throw new Error('no wallet: connect one (aero wallet connect/create) or pass --wallet')
  const client = new SugarClient(almConfig.chain, { account: normalizeAddress(wallet) })
  const state = loadAlmState()
  const pending = Object.values(state).flatMap((entry) => entry.cycle?.status.kind === 'active' ? [entry.cycle] : [])
    .filter((cycle) => cycle.chain === almConfig.chain && normalizeAddress(cycle.wallet) === normalizeAddress(wallet))
  if (pending.length > 0) {
    yield* Console.log(JSON.stringify({ status: 'manual recovery required', cycles: pending }, null, 2))
    return
  }
  const now = Date.now()
  const report = []
  for (const entry of almConfig.positions) {
    const positionState = state[positionStateKey(almConfig.chain, entry.pool, wallet)] ?? state[positionStateKey(almConfig.chain, entry.pool)]
    const selectedId = managedPositionId(positionState, entry.positionId)
    const [spot, position] = yield* fromPromise(() => Promise.all([
      readPoolTick(client.publicClient, entry.pool),
      selectedId === undefined ? client.getPositionByPool(entry.pool) : client.getPositionById(selectedId, client.account, entry.pool),
    ]))
    if (!position) {
      report.push({ pool: entry.pool, status: 'no position found for this wallet' })
      continue
    }
    const settings = strategySettingsFor(entry, position.pool.type, position.tickUpper - position.tickLower)
    const gate = checkRebalanceGate(positionState, now, entry.cooldownMinutes, entry.maxRebalancesPerDay)
    report.push({
      pool: entry.pool,
      position_id: position.id.toString(),
      symbol: position.pool.symbol,
      strategy: settings.strategy,
      width_ticks: settings.widthTicks,
      range: [position.tickLower, position.tickUpper],
      tick: spot.tick,
      in_range: position.tickLower <= spot.tick && spot.tick < position.tickUpper,
      staked: position.staked > 0n,
      emissions_earned: position.pool.emissionsToken ? tokenToNumber(position.pool.emissionsToken, position.emissionsEarned) : null,
      rebalance_gate: gate.allowed ? 'ready' : gate.reason,
    })
  }
  yield* Console.log(JSON.stringify(report, null, 2))
})).pipe(Command.withDescription('Show tick, range, and gate status for every managed position'))

export const almCommand = Command.make('alm').pipe(
  Command.withDescription('Configure the self-hosted ALM used by aero serve'),
  Command.withSubcommands([init, status, safeSetup, almRecoverCommand, almResolveCommand]),
)

export const serveCommand = serve
