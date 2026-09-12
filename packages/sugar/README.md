# `@beegreat/sugar`

> This is an independent project and is not affiliated with, endorsed by, sponsored by, or maintained by Aerodrome Finance, Velodrome Finance, Dromos Labs, or Mellow Protocol. References to their names and protocols describe compatibility or source attribution only. All trademarks belong to their respective owners. Third-party code remains subject to its applicable licenses.

> ⚠️ **Vibecoded & early beta — use at your own risk.** This SDK and the
> `aero` CLI were vibecoded with AI agents and are in early beta. Expect
> rough edges and breaking changes. Always review unsigned plans
> (`--dry-run`) before signing, start with small amounts, and never risk
> funds you cannot afford to lose.

Native TypeScript port of Velodrome/Aerodrome's Sugar SDK. It uses Viem for
RPC reads and ABI encoding and never signs or broadcasts transactions.

## Standalone repository

This package is developed in the BeeGreat monorepo (`packages/sugar`) and
mirrored to [OxFrancesco/UNOFFICIAL-Aero-SDK](https://github.com/OxFrancesco/UNOFFICIAL-Aero-SDK)
with an MIT license for original contributions. Third-party material retains its
applicable terms; see the licensing review below before redistribution. The
monorepo is the source of truth; mirror after landing changes with
`bun run sugar:mirror` from the monorepo root. Standalone usage:

```sh
bun add github:OxFrancesco/UNOFFICIAL-Aero-SDK   # as a dependency
# or work in a clone:
bun install && bun test && bun run typecheck
bun run cli -- pools --chain=8453 --pool-type=cl --limit=5
```

## Licensing review 2026-09-06

This is a technical license review, not a legal opinion or a finding of
non-infringement. Do not treat the MIT file or the non-affiliation notice as
clearance for upstream material. The following issues remain open before further
redistribution or production use of potentially restricted derivatives.

| Source | Verified terms | Consequence for this package |
| --- | --- | --- |
| [Python Sugar SDK](https://github.com/velodrome-finance/sugar-sdk/blob/e8f7c6a8c069aa23376837fb4eafc53b1377bfdd/LICENSE) | Apache-2.0. [Metadata](https://github.com/velodrome-finance/sugar-sdk/blob/e8f7c6a8c069aa23376837fb4eafc53b1377bfdd/settings.ini) identifies copyright 2025 Velodrome Finance. | Commercial use and ports are permitted subject to the license. Section 4 requires a license copy, notices on modified files, retained applicable attribution, and relevant NOTICE content if supplied. The package now includes LICENSE.Apache-2.0, NOTICE, and change notices on the identified ported TypeScript modules. Fifteen ABI files match the inspected Python reference byte-for-byte. Remaining ABI provenance and historical attribution checks are listed in NOTICE. |
| [Official TypeScript SDK](https://github.com/velodrome-finance/sdk.js/blob/6b0be4a253a317a0bf5e4620f4e5327db0f80b58/packages/sugar-sdk/package.json) | `UNLICENSED` in package and root metadata. No LICENSE or NOTICE file found in the main tree at review time. | No general reuse grant was found. Do not copy or translate its implementation without permission. This package does not list it as a dependency, but references to its behavior are not proof of independent authorship. Review source history and ABI provenance. |
| [Aerodrome contracts license](https://github.com/aerodrome-finance/contracts/blob/1ba30815bba620f7e9faa34769ffd00c214c9b82/LICENSE) and [NOTICE](https://github.com/aerodrome-finance/contracts/blob/1ba30815bba620f7e9faa34769ffd00c214c9b82/NOTICE) | Mixed BSL-1.1, GPL-3.0, and MIT. The local Velodrome contracts reference has the same BSL parameters. | Check each copied file, not just the repository license. Calling a deployed contract through RPC is distinct from distributing or deploying its implementation. Generated ABI artifacts still need provenance review; no blanket exemption is assumed. |
| [Mellow PulseStrategyModule](https://github.com/mellow-finance/mellow-alm-toolkit/blob/bb6da8fe6697dd09ecdd55d327b91a83ae6e7cb9/src/modules/strategies/PulseStrategyModule.sol) | `BUSL-1.1`; [license parameters](https://github.com/mellow-finance/mellow-alm-toolkit/blob/bb6da8fe6697dd09ecdd55d327b91a83ae6e7cb9/licenses/LICENSE) name February 15, 2028 as the change date. The inspected production-use grant list contains only a newline. | `src/alm/strategy.ts` says it replicates this module. LICENSE.Mellow-BUSL-1.1 and NOTICE preserve the upstream terms without claiming production permission. ALM execution remains unchanged at the maintainer's request. Obtain permission or resolve derivative-work status before production use; dry-run mode is not legal clearance. |

The contracts' BSL parameters name Perpetual Cyclist Services LLC and refer to
`v2-license-grants.velodrome.eth` and `v2-license-date.velodrome.eth`. The license
converts each version to GPL-2.0-or-later on its change date or the fourth
anniversary of that version's first public BSL distribution, whichever is earlier.
This review did not resolve those ENS records or establish version-specific first
publication dates. Do not assume the whole repository has already converted.
GPL-covered implementation redistribution has its own source and notice duties.

Apache section 6 and the contracts' BSL text do not grant general trademark or logo
rights. New CLI WalletConnect pairings now use our own repository URL, an
unofficial description, and no upstream logo. Existing sessions may cache old
metadata until disconnected and paired again. Repository names, other UI assets,
API terms, patents, and jurisdiction-specific trademark questions are not cleared
by this review.

Release follow-up:

- Map ported source and every ABI to an upstream file and revision. Include the
  full applicable license texts and copyright notices in source and binary
  distributions. Mark modified files as required. The ignored `resources/` folder
  does not supply notices to consumers of this package or its standalone mirror.
- Obtain written permission for any reused `UNLICENSED` implementation, or replace
  it through a documented independent implementation process. A language rewrite
  alone does not remove copyright obligations.
- Resolve the Mellow ALM provenance and BSL grant before claiming production reuse
  is permitted. Have qualified counsel review uncertain derivative-work questions.
- Keep [LICENSE](./LICENSE), [LICENSE.Apache-2.0](./LICENSE.Apache-2.0),
  [LICENSE.Mellow-BUSL-1.1](./LICENSE.Mellow-BUSL-1.1), and [NOTICE](./NOTICE)
  in source mirrors and bundled distributions. Package metadata explicitly includes
  them. Bundled dependencies require their own applicable license notices.
- Keep non-affiliation notices in other integrations and future repositories.
  This review is not an exhaustive audit of every repository or historical release.

## Client API

```ts
import { SugarClient, parseTokenUnits } from '@beegreat/sugar'

const sugar = new SugarClient(8453, {
  account: '0xYourPublicWalletAddress',
})

const eth = await sugar.getToken('ETH')
const usdc = await sugar.getToken('USDC')
if (!eth || !usdc) throw new Error('token unavailable')

const quote = await sugar.getQuote(eth, usdc, parseTokenUnits(eth, '0.01'))
const unsignedTransactions = quote
  ? await sugar.swapFromQuote(quote)
  : []
```

`SugarClient` ports the Python chain surface:

- token, balance, pool, oracle-price, epoch, and position reads;
- mixed V2/V3 path discovery, quotes, and swaps;
- pool specs and basic/concentrated deposit quotes;
- deposit, withdrawal, stake, unstake, fee, and emission builders;
- native veNFT reads, lock lifecycle, voting, managed delegation, rebases, and voting-reward claims;
- pool voting-reward discovery and incentive funding;
- bridge fees, ICA reads, bridge transaction builders, and allowances.

Every transaction result is `{ from, to, data, value }`. `value` and other
on-chain integers are `bigint` in the SDK and decimal strings after JSON
serialization.

## veNFTs and voting rewards

Native veNFT management is available on the two governance-root deployments:
Optimism (Velodrome) and Base (Aerodrome). Superchain leaf deployments support
pool gauges and voting incentives, but do not expose a local VotingEscrow; veNFT
methods reject locally on those chains instead of returning unusable calldata.

```ts
const sugar = new SugarClient(8453, { account: wallet })

const locks = await sugar.getVeNfts()
const pools = await sugar.getPools()
if (!locks[0] || !pools[0]) throw new Error('veNFT or pool unavailable')
const create = await sugar.createVeNft(amount, 4 * 365 * 24 * 60 * 60)
const vote = await sugar.voteVeNft(locks[0].id, [
  { pool: pools[0].lp, weight: 1n },
])
const rewards = await sugar.getVeNftRewards(locks[0].id)
const claims = await sugar.claimVeNftRewards(locks[0].id)
const rebase = await sugar.claimVeNftRebase(locks[0].id)
```

The lifecycle surface also includes `getVeNft`, `increaseVeNftAmount`,
`extendVeNftLock`, `withdrawVeNft`, `mergeVeNfts`, `splitVeNft`,
`setVeNftPermanent`, `delegateVeNft`, `resetVeNftVotes`, `pokeVeNftVotes`,
`depositVeNftIntoManaged`, `withdrawVeNftFromManaged`, and batched rebase claims.

Pool incentive funding is chain-agnostic. `incentivizePool(pool, token, amount)`
resolves the correct BribeVotingReward/IncentiveVotingReward contract for the
chain, adds an ERC-20 approval only when required, and returns the unsigned
`notifyRewardAmount` transaction. Existing `stake`, `unstake`,
`claimEmissions`, and `claimFees` methods continue to manage LP rewards.

## CLI-compatible action seam

The Web3 power-up uses the same twelve action names as the former Python CLI:

```ts
import { executeSugarActionJson } from '@beegreat/sugar'

const output = await executeSugarActionJson('pools', {
  chain: 8453,
  pool_type: 'cl',
  limit: 10,
})
```

Supported actions are `deposit`, `positions`, `pools`, `epochs_latest`,
`epochs`, `withdraw`, `stake`, `unstake`, `claim_emissions`, `claim_fees`,
`quote`, and `swap`.

The same actions are available from the Bun CLI:

```sh
bun run --cwd packages/sugar cli -- pools --chain 1135 --limit 1
bun run --cwd packages/sugar cli -- quote --chain 1135 \
  --from-token ETH --to-token USDT --amount 0.001 --use-decimals
```

The `sugar-ts` package bin exposes that entrypoint to workspace consumers
(`aero` is an alias). The SDK layer only returns JSON reads and unsigned
transactions; signing lives exclusively in the CLI wallet flow below.

### Analytics TUI (`aero tui`)

`aero tui` → **Analytics** is a [Dune Analytics](https://dune.com) dashboard
for Aerodrome ve(3,3) mechanics. Charts mix two terminal renderers:
[dither-kit](https://www.tripwire.sh/dither-kit) ordered dither (Bayer 8×8
fills: gradient, hatched, dotted, solid) and **braille sub-pixel line
charts** — each cell packs a 2×4 dot grid, giving Dune-smooth multi-series
curves. Also in the chart kit: donuts for composition, calendar heatmaps,
waterfalls for epoch flow, and scatter quadrant maps.

| Tab | What it shows |
| --- | --- |
| Health | KPI strip, braille volume + CL-vs-legacy fee lines, TVL-mix donut, 16-week activity heatmap |
| Flywheel | RPV per 10k ve, bribe ROI, epoch waterfall (fees + bribes − emissions), hold vs LP vs lock+vote |
| Trade | Ranked pools with lens sorting, liquidity map (turnover × TVL scatter), weekly volume |
| Token | Locked-vs-liquid supply donut, real yield, P/S and P/F |
| Arena | Side-by-side vs Uniswap / Pancake on the same chain |

Browse screens carry the same visual language: pools list TVL bars inline,
and the epochs screen opens with a stacked vote-share banner. Analytics
reports are cached session-wide (60s SWR) so tab flips and back-navigation
replay instantly; `ctrl+r` forces a cold reload.

Pools, positions, epochs, the swap token catalog, and analytics persist to disk snapshots
(`~/.cache/aero/snapshots`, override with `AERO_CACHE_DIR`), so a relaunch
renders the last dataset instantly with a `◌ data from Xm ago — refreshing…`
badge while the live scan replaces it in the background. Snapshots feed
browse/analytics screens only — quotes and transaction building always read
live chain state. Loading spinners show live scan progress (`N rpc reads`).
Pinning your own endpoint (`SUGAR_RPC_URI_<chainId>`) additionally raises
the scan concurrency from 5 to 16 and parallelizes startup warming, since a
dedicated RPC tolerates the fan-out that public endpoints rate-limit.

On-chain reads use the same Sugar client as the rest of the TUI.
Each number is tagged with its source:

- **Sugar** — live on-chain TVL, pools, epochs, ve locks
- **Dune Analytics** — [Hoodie Crew RPV #7907454](https://dune.com/queries/7907454)
  and `dex.trades` SQL (weekly volume, Base share)
- **DefiLlama** — fees, TVL history, Slipstream vs v1, mcap / P/S

Set `DUNE_API_KEY` (or `SUGAR_DUNE_API_KEY`) from
[dune.com/settings/api](https://dune.com/settings/api). Without a key the
screen still shows the live on-chain snapshot. `aero guide analytics` is
the walkthrough.

### Wallet-connected CLI (aero)

The interactive CLI is built on `effect/unstable/cli`: every action is a
typed subcommand with described flags (`aero <command> --help`), any command
can be filled in interactively with `--wizard`, shell completions are
generated with `aero --completions zsh|bash|fish`, and `aero guide <topic>`
prints in-terminal walkthroughs (getting-started, wallet, swap, liquidity,
staking, rewards, venft, alm, chains, completions).

The CLI can connect a wallet and broadcast the plans it builds:

```sh
aero wallet connect      # WalletConnect: QR pairing with an extension/mobile wallet
aero wallet create       # new local wallet; mnemonic sealed with scrypt + AES-256-GCM
aero wallet restore      # import an existing mnemonic into the encrypted store
aero wallet status       # active wallet and source
aero wallet disconnect   # drop the WalletConnect session
aero wallet remove       # delete the local encrypted wallet (confirmed)

aero swap --from-token ETH --to-token USDC --amount 0.1 --use-decimals
```

Every command defaults `--chain` to Base (8453, Aerodrome). Transaction
actions (`swap`, `deposit`, `withdraw`, `stake`, `unstake`, `claim-emissions`,
`claim-fees`, `create-venft`) fill `--wallet` from the active wallet, print a
human summary, and ask for confirmation before broadcasting each step
(approvals first, receipts awaited). `--yes` skips the prompt; `--dry-run`
always prints the unsigned plan. Without a wallet the CLI prints unsigned
JSON.

Wallet security: WalletConnect wallets sign in-app, so no key material ever
reaches the CLI. Local wallets keep the mnemonic sealed with scrypt +
AES-256-GCM; the ciphertext lives in the macOS Keychain (generic password,
iCloud Keychain syncable) with a `0600` file fallback elsewhere, and the
plaintext mnemonic is shown once at creation and never written to disk.
Environment: `WALLETCONNECT_PROJECT_ID` (optional override of the built-in
public Reown project id), `SUGAR_WALLET_PASSPHRASE` (non-interactive local
signing), `SUGAR_WALLET_DIR` / `SUGAR_WALLET_NO_KEYCHAIN` (storage overrides).

### Self-hosted ALM (aero serve)

`aero serve` watches the configured concentrated positions and rebalances
them like Aerodrome's ALM vaults — the strategy layer (`src/alm/`) is an
off-chain reimplementation of Mellow's PulseStrategyModule (`original`,
`lazy-syncing`, `lazy-ascending`, `lazy-descending`, and the Pulse V2
`expand`), with Mellow's production widths as defaults.

```sh
aero alm init            # scaffold ~/.config/sugar-ts/alm.json from your CL positions
aero serve               # dry-run daemon: logs/notifies what it WOULD do
aero serve --execute     # unlock the local wallet and rebalance for real
aero serve --once        # single pass, for cron
aero alm status          # tick, range, and gate status per managed position
```

Safety: dry-run is the default; `--execute` requires the local encrypted
wallet (WalletConnect cannot approve unattended); every phase is simulated
via `eth_simulateV1` before signing (an RPC without it blocks broadcasting
unless `--allow-unsimulated`); rebalances pass a Mellow-style TWAP deviation
guard, a per-position cooldown, and a rolling daily cap persisted in
`alm-state.json`; `"telegram": true` sends buddytg push notifications.
`AERO_ALM_CONFIG` overrides the config path. See `aero guide alm`.

Safe execution and `aero alm safe-setup` are disabled for 0.1. Safe dry-run
observation remains available. The previous role allowed unrestricted router
command bytes. This update does not revoke deployed permissions: Safe owners
must review and revoke old keeper roles or disable their Roles module.
Do not treat the old role as protection against a compromised keeper.

EOA execution remains experimental pending fork tests. Rebalances and compounds
check TWAP before every submission. Local fallback weights elapsed time and
requires a full window without gaps longer than two poll intervals. It is a
sampled estimate, not an on-chain oracle or protection against all MEV.

The daemon records the wallet, pool, original NFT, intended range, balance
baselines and phase journal IDs before sending. Transaction journals preserve
submitted hashes and receipt state. Rebalance attempts consume the daily cap
and cooldown when the cycle starts; compound attempts start the 24-hour delay.
Partial failures do not reset those limits. State writes are atomic and synced,
and an exclusive state-file lock prevents overlapping local ALM passes.

ALM config entries accept `positionId` as a decimal string. `aero alm init
--position-id <id>` selects one NFT when several share a pool. Each pool has one
managed NFT; successful rebalances persist its replacement ID across restarts.
Manual recovery accepts `--position-id <repaired-id>` and verifies a funded NFT
owned by the same wallet in the same pool before updating that identity.

After interruption, the daemon reconciles known hashes but does not replay
phases or start another cycle for that wallet and chain. Use:

```sh
aero alm status
aero alm recover --id <cycle-id>
aero alm resolve --id <cycle-id> --note "Verified receipts and repaired the position"
```

`recover` only reads receipts. Repair partial positions manually before
confirming `resolve`, which cancels unsubmitted remainder and keeps attempt
limits. Pending submissions or unknown outcomes without a hash block resolution.
Those require operator investigation; the daemon never guesses that a send failed.
Missing/corrupt journals and stale process locks also require review. Do not
clear state or locks to retry blindly. Automatic phase resumption, multi-host
coordination and concurrent external trading in the managed wallet are unsupported.

## Chain clients

`OPChain`, `BaseChain`, `LiskChain`, `UniChain`, `ModeChain`, `FraxtalChain`,
`InkChain`, `SoneiumChain`, `SuperseedChain`, and `CeloChain` mirror the
Python chain-specific classes. `getChain`, token-based factories, async-name
aliases, and Lisk/Uni Supersim clients are exported as well.

## Superswap

`Superswap` ports the OP/Lisk/Uni cross-chain quote and unsigned transaction
flow. If a destination ICA relay is required, the returned result includes
`swapData`; pass the commitment transaction hash to `result.relayArgs(...)`
and then to a `SuperswapRelayer`.

## Configuration

The defaults and environment names match the Python SDK. Per-chain overrides
use names such as `SUGAR_RPC_URI_8453`, `SUGAR_SWAP_SLIPPAGE_8453`, and
`SUGAR_CONNECTOR_TOKENS_ADDRS_8453`; un-suffixed global values are also
accepted. Constructor options take precedence over environment values.

Supported chain IDs: 10, 130, 252, 1135, 1868, 5330, 8453, 34443, 42220,
and 57073. Local Supersim settings are available for Uni (130, port 4446) and
Lisk (1135, port 4445).

### RPC resilience

Sugar keeps its public interface Promise-based while using Effect internally
for RPC deadlines, retry classification, and bounded read concurrency. The
SDK-owned HTTP transport disables Viem retries so one policy owns all attempts.
By default, idempotent reads receive up to three retries with 150ms exponential
backoff inside a 120-second total deadline. Numeric and HTTP-date `Retry-After`
headers are honored without extending that deadline. Multi-stage reads share one
budget across pagination count/pages and quote multicall/fallback work; exhausted
rate limits and transport failures are not amplified through the quote fallback.

Callers can tune this with plain TypeScript options (no Effect types cross the
SDK interface):

```ts
const sugar = new SugarClient(8453, {
  onRpcEvent: (event) => telemetry.record(event),
  rpcPolicy: {
    maxRetries: 2,
    baseDelayMs: 250,
    deadlineMs: 60_000,
  },
})
```

`onRpcEvent` is optional and silent by default. It reports operation/phase,
duration, aggregate attempts, and pagination item/page counts without wallet
addresses or calldata. Pass the same callback in the options to
`createSugarFailoverTransport(rpcUrls, { onRpcEvent })` to record whether a
backup RPC endpoint was used; endpoint URLs are not included.

Expected RPC failures reject with `SugarRpcError`, whose `code` is one of
`RPC_TIMEOUT`, `RPC_RATE_LIMITED`, `RPC_UNAVAILABLE`, or `RPC_READ_FAILED`.
The original Viem error remains available as `cause`.

Addressed pool and position reads can avoid a cold global pool scan by
providing a durable `poolLocatorStore`. A stored offset is never trusted
blindly: every new client verifies it with `Sugar.all(1, offset)` and deletes
it before falling back to discovery when the pool no longer matches.

```ts
const sugar = new SugarClient(8453, {
  poolLocatorStore: {
    get: (key) => database.poolOffsets.get(key),
    set: (key, locator) => database.poolOffsets.set(key, locator),
    delete: (key) => database.poolOffsets.delete(key),
  },
})
```

The store is an optimization only. Store errors fall back to verified on-chain
reads and cannot make Sugar unavailable.

When injecting a custom `transport` or `publicClient`, configure its own retry
count to zero if Sugar should remain the sole retry owner. Effect can interrupt
its wait and sibling retry fibers at the deadline, but the underlying transport
may continue until its own timeout. An injected client is responsible for
physically aborting its network request when it supports cancellation.

## Headless verification

```sh
bun run --cwd packages/sugar test:headless
```

This runs the TypeScript CLI end to end against Lisk by default: a pool read,
an ETH-to-USDT quote, and unsigned swap construction. It never broadcasts.
Override `SUGAR_HEADLESS_CHAIN_ID`, `SUGAR_HEADLESS_RPC_URL`, token names,
amount, or public wallet address as needed. The upstream SDK does not ship a
public testnet deployment; its supported test environment is local Supersim,
so point `SUGAR_HEADLESS_RPC_URL` at the appropriate fork when it is running.

CLI and TUI swap confirmations show both resolved asset addresses before signing.
WalletConnect uses one client per process and checks the current session against
the exact sender, chain and transaction permission before every submission.
Session expiry, deletion and account changes invalidate the local connection.

## Tokenized stocks and wallet indices

`aero stocks list` reads the ten Base stocks tracked by Dromos Kitchen.
`aero stocks buy --stock NVDAc --amount 25` spends 25 USDC;
`aero stocks sell --stock NVDAc --amount 0.1` sells 0.1 token units.
Both use the existing review and wallet-signing flow. Add `--dry-run` to
print the unsigned plan.

Create a local allocation with
`aero index create --name tech --allocations 'NVDAc=50,AAPLc=50'`, then preview
`aero index rebalance --name tech --cash 100 --dry-run`.
`index list`, `show`, `update`, and `delete` manage the saved definitions.
Stocks and Indices are also available in `aero tui`, including weight bars,
an editor, and a current-versus-target rebalance preview.

Indices use all wallet holdings of their named stocks. They are local recipes,
not separate funds. Only the explicit `--cash` contribution spends existing
USDC. Keep an exiting stock at 0% until sold. The basket executes atomically,
and approvals account for the total spending across every leg.
