import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'

const GUIDE_TOPICS = [
  'getting-started',
  'wallet',
  'swap',
  'liquidity',
  'staking',
  'rewards',
  'venft',
  'alm',
  'analytics',
  'chains',
  'completions',
] as const

type GuideTopic = (typeof GUIDE_TOPICS)[number]

const GUIDES = {
  'getting-started': `Getting started with aero
=========================

⚠️  aero is vibecoded and in EARLY BETA — use it at your own risk. Review
every plan with --dry-run before signing, start with small amounts, and
never risk funds you cannot afford to lose.

aero talks to Aerodrome (Base) and Velodrome (OP Superchain) straight from
your terminal. Reads print JSON; transaction commands build an unsigned plan
and only broadcast after you connect a wallet and confirm.

A five-minute tour:

  1. aero pools --token0 ETH --token1 USDC --full --limit 3
       Look around. No wallet needed for reads.
  2. aero quote --from-token ETH --to-token USDC --amount 0.05 --use-decimals
       Price a swap, including route and price impact.
  3. aero wallet connect
       Pair your mobile/extension wallet via WalletConnect (or
       'aero wallet create' for a local encrypted wallet).
  4. aero swap --from-token ETH --to-token USDC --amount 0.05 --use-decimals
       Review the plan summary, confirm, approve in your wallet.

Not sure which flags a command needs? Every command supports
  aero <command> --wizard
which asks for each value interactively. --dry-run always prints the plan
without sending anything, and --yes skips the confirmation for scripts.

  5. aero tui  →  Analytics
       Dune-style E/R, RPV, and Base share, dithered in the terminal.

Next: aero guide wallet | swap | liquidity | staking | rewards | venft | analytics`,

  wallet: `Wallets
=======

Two ways to sign:

  WalletConnect (recommended)   aero wallet connect
    Scan the QR (or paste the wc: URI) with Rabby, Rainbow, MetaMask, or a
    Safe. Every transaction is approved inside your wallet app; aero never
    sees a private key.

  Local encrypted wallet        aero wallet create | aero wallet restore
    Generates (or imports) a BIP-39 mnemonic, seals it with scrypt +
    AES-256-GCM, and stores it in the macOS Keychain (an encrypted 0600 file
    elsewhere). Signing asks for your passphrase; set SUGAR_WALLET_PASSPHRASE
    for non-interactive use.

Housekeeping:

  aero wallet status       who is connected, and on which chains
  aero wallet disconnect   drop the WalletConnect session
  aero wallet remove       delete the local encrypted wallet

When both exist, WalletConnect wins (pairing is an explicit recent action).
Transaction commands use the connected wallet automatically when --wallet is
omitted; passing a different --wallet prints an unsigned plan instead.`,

  swap: `Swapping
========

Price first, then trade:

  aero quote --from-token ETH --to-token USDC --amount 0.1 --use-decimals
  aero swap  --from-token ETH --to-token USDC --amount 0.1 --use-decimals

What the swap plan contains:
  - the best route across basic, stable, and CL pools (up to 3 hops through
    vetted connector tokens only — honeypot intermediates cannot appear)
  - ERC20 + Permit2 approvals when needed (listed before the swap itself)
  - a minimum-out floor from --slippage (default 0.01 = 1%)
  - an oracle sanity guard: quotes wildly above fair value are rejected

Tips:
  --use-decimals lets you write 0.1 instead of 100000000000000000.
  --dry-run prints the unsigned plan as JSON (pipe it anywhere).
  --slippage 0.005 tightens the floor for large, liquid pairs.
  Guided mode: aero swap --wizard`,

  liquidity: `Providing liquidity
===================

Find a pool, quote the deposit, add liquidity:

  aero pools --token0 ETH --token1 USDC --full
  aero deposit --pool <lp address> --amount0 0.1 --use-decimals

Pass only one amount for an existing pool — the other side is quoted for
you. Instead of --pool you can describe a new pool with --token0/--token1
and --pool-type (volatile | stable | cl; CL also needs --tick-spacing).

Concentrated liquidity ranges take either prices or ticks:
  aero deposit --pool <cl pool> --amount0 500 --use-decimals \\
    --price-lower 2200 --price-upper 2800

Withdrawing:
  aero positions
  aero withdraw --position <id> --pool <lp>          everything
  aero withdraw --position <id> --pool <lp> --fraction 0.5
  CL extras: --burn (retire the empty NFT), --unwrap-native, --no-collect

After depositing, stake the position to earn emissions: aero guide staking`,

  staking: `Staking
=======

Liquidity earns trading fees; STAKED liquidity earns AERO/VELO emissions
from the pool's gauge instead. Fees for staked positions go to the pool's
voters, so pick one: fees (unstaked) or emissions (staked).

  aero positions                          find your position id
  aero stake --position <id> --pool <lp>
  aero claim-emissions --position <id> --pool <lp>    any time
  aero unstake --position <id> --pool <lp>            leave the gauge
    (basic pools can unstake partially with --amount)

Notes:
  - staking a CL position transfers the NFT into the gauge (approval first)
  - a position must be unstaked before withdrawing or claiming fees
  - gauges must be alive (voted for); aero checks and tells you if not`,

  rewards: `Rewards
=======

Three separate reward streams:

  Trading fees (unstaked LPs)
    aero claim-fees --position <id> --pool <lp>
    CL extras: --unwrap-native, --burn (empty position only)

  Gauge emissions (staked LPs)
    aero claim-emissions --position <id> --pool <lp>

  Voting rewards (veNFT voters)
    Voters earn the fees + incentives of pools they vote for, claimable
    per epoch. Inspect what a pool paid recently:
      aero epochs-latest
      aero epochs --lp <pool address>

Epoch flip is Thursday 00:00 UTC — claim voting rewards after the flip.`,

  venft: `veNFTs (vote-escrow)
====================

Lock AERO (Base) or VELO (Optimism) into a veNFT to get voting power that
directs emissions and earns voting rewards.

  aero create-venft --amount 100 --use-decimals --lock-duration-seconds 31536000

Duration is rounded down to whole weeks; the maximum is 4 years. Longer lock
= more voting power. The plan includes the governance-token approval.

The SDK also builds every lifecycle transaction (the agent tools expose
them): increase / extend / merge / split / permanent locks, vote / reset /
poke, managed-veNFT deposits, rebase claims, and pool incentives.

Lock durations cheat sheet:
  1 week 604800 | 1 month 2592000 | 6 months 15552000
  1 year 31536000 | 4 years 126144000`,

  alm: `Self-hosted ALM (aero serve)
============================

Concentrated positions drift out of range as prices move. Aerodrome's ALM
vaults (built on Mellow) rebalance them for you; 'aero serve' is the same
keeper running on YOUR machine with YOUR wallet — no vault contracts, no
fees, your strategy.

Set it up:

  1. aero alm init                 scaffold ~/.config/sugar-ts/alm.json from
                                   your current CL positions
  2. aero serve                    dry-run: log/notify what WOULD happen
  3. aero serve --execute          unlock the local wallet and go live
     aero alm status               tick, range, and gate status per position

Strategies (per position, in the config file):
  original         recenter the same width when the tick exits the range
                   (what most Mellow vaults run)
  lazy-syncing     only follow full breaches; the new range sits adjacent to
                   the tick, so no swap is needed
  lazy-ascending / lazy-descending   directional variants
  expand           Pulse V2: widen the range instead of recentering; reset
                   to the default width past maxWidthTicks

Safety rails (all on by default):
  - dry-run unless --execute is passed
  - every phase is simulated via eth_simulateV1 before signing
    (use an RPC that supports it, e.g. Alchemy; --allow-unsimulated to skip)
  - TWAP deviation guard against manipulation/wicks (Mellow-style)
  - per-position cooldown + daily rebalance cap, persisted across restarts
  - telegram: true in the config sends buddytg push notifications

A rebalance runs: claim emissions -> unstake -> withdraw+burn -> swap to the
new ratio -> deposit the new range -> stake. Emissions are auto-compounded
back into the position (claim -> swap -> increase liquidity) once they pass
minCompoundEmissionsDecimal.

Costs: gas on Base is negligible; the real cost is swap fees + slippage on
every recenter. Wider ranges and longer cooldowns rebalance less.
--execute needs the LOCAL encrypted wallet (aero wallet create/restore);
WalletConnect cannot approve transactions unattended.

Recovery and 0.1 limits
-----------------------

EOA execution is experimental pending fork tests. Every submission, including
compound transactions and actions after approvals, rechecks TWAP. The local
fallback weights elapsed time, requires a full window, and rejects gaps longer
than two poll intervals. Attempts count toward cooldowns and caps even if a
later phase fails.

A persisted cycle binds chain, wallet, pool and NFT identity to its range,
balance baselines and transaction journals. Interrupted cycles block new work
for that wallet and chain, even if the old NFT was burned. The daemon checks
known receipts on restart but never automatically repeats a phase.

  aero alm status
  aero alm recover --id <cycle-id>
  aero alm resolve --id <cycle-id> --note <verified-outcome>

Recover only checks receipts. Inspect balances, NFT ownership and staking,
repair partial work manually, then confirm resolve to permit future cycles.
Resolve cancels unsubmitted remainder; unknown or pending submissions block it.
A send with no known hash, missing/corrupt state, or a stale lock needs operator
investigation. Never delete safety state just to force a retry.

Safe execution and safe-setup are disabled for 0.1 pending on-chain permission
verification. Safe observation in dry-run remains available. Old deployed
keeper roles are NOT revoked by this update. Safe owners must review and revoke
them or disable the Roles module; the old unrestricted router permission did
not establish protection against a compromised keeper.

Automatic phase resumption, multi-host locking, and concurrent external trades
in the managed wallet are unsupported.`,

  analytics: `Analytics (Dune Analytics in the TUI)
=====================================

aero tui  →  Analytics

A dithered dashboard for ve(3,3) health. Charts use a Bayer 8×8 ordered
dither (dither-kit fills: gradient, hatched, dotted, solid) plus braille
sub-pixel line charts (2×4 dots per cell for Dune-smooth curves), donuts,
calendar heatmaps, waterfalls, and scatter maps. Reports cache per session
(stale-while-revalidate, 60s); ctrl+r forces a cold reload.

Every panel is tagged with its source (Sugar · Dune · DefiLlama):

  Sugar        live on-chain TVL, pools, epochs, ve locks
  Dune         dune.com — Hoodie Crew #7907454 (RPV) and dex.trades SQL
  DefiLlama    defillama.com — fees, TVL history, Slipstream vs v1, mcap

Set DUNE_API_KEY from dune.com/settings/api for Dune series.
Sugar and DefiLlama work without a key.

  1 health     KPI strip, braille volume + CL-vs-legacy fee lines,
               TVL-mix donut, 16-week activity heatmap
  2 flywheel   RPV ($ / 10k ve voted), bribe ROI, epoch waterfall
               (fees + bribes - emissions), three-doors on the same $10k
  3 trade      ranked pools (v volume / f fees / e efficiency / p RPV),
               liquidity map (turnover x TVL scatter), weekly volume
  4 token      locked-vs-liquid supply donut, real yield, P/S and P/F
  5 arena      Aerodrome vs Uniswap vs Pancake from Dune dex.trades

Keys: ← → or 1-5 to change tab, ctrl+r to refresh, enter on a ranked
row for that pool's epoch history. Dune coverage is Base (Aerodrome);
other Superchain leaves show the on-chain snapshot only.

E/R < 1 means the last settled epoch's fees + bribes exceeded emissions
(protocol is earning its keep). RPV is the actionable voter number.`,

  chains: `Chains
======

Every command accepts --chain <id>; the default is 8453 (Base, Aerodrome).

  10    Optimism (Velodrome)     1135  Lisk
  130   Unichain                 1868  Soneium
  252   Fraxtal                  5330  Superseed
  8453  Base (Aerodrome)         34443 Mode
  42220 Celo                     57073 Ink

RPC overrides: set SUGAR_RPC_URI_<chainId> (e.g. SUGAR_RPC_URI_8453) to use
your own endpoint instead of the public default.`,

  completions: `Shell completions
=================

aero ships completion scripts for bash, zsh, and fish:

  zsh   aero --completions zsh  > ~/.config/zsh/completions/_aero
        (ensure the directory is in your fpath, then: autoload -Uz compinit && compinit)

  bash  aero --completions bash > ~/.local/share/bash-completion/completions/aero

  fish  aero --completions fish > ~/.config/fish/completions/aero.fish

Completions cover every subcommand and flag, including choice values like
--pool-type. Regenerate after upgrading aero.

Also handy: every command supports --wizard for interactive, prompted input.`,
} satisfies Record<GuideTopic, string>

export const guideCommand = Command.make('guide', {
  topic: Argument.choice('topic', GUIDE_TOPICS).pipe(
    Argument.optional,
    Argument.withDescription('Guide to read (omit to list all topics)'),
  ),
}, Effect.fn(function* (config) {
  const topic = Option.getOrUndefined(config.topic)
  if (topic === undefined) {
    yield* Console.log([
      'aero guides — pick a topic:',
      '',
      ...GUIDE_TOPICS.map((name) => `  aero guide ${name}`),
      '',
      "New here? Start with 'aero guide getting-started'.",
    ].join('\n'))
    return
  }
  yield* Console.log(GUIDES[topic])
})).pipe(Command.withDescription('In-terminal walkthroughs: swaps, liquidity, staking, rewards, veNFTs, analytics'))
