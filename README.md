# evmSDK

An agent-first Bun toolkit for Ethereum, Base and configurable EVM chains. The Effect SDK, JSON CLI, OpenTUI interface and MCP server share command schemas and execution services.

> This is an independent project and is not affiliated with, endorsed by, sponsored by, or maintained by Aerodrome Finance, Velodrome Finance, Dromos Labs, or Mellow Protocol. References to their names and protocols describe compatibility or source attribution only. All trademarks belong to their respective owners. Third-party code remains subject to its applicable licenses.

## Run

```sh
bun install
bun run cli discover
bun run cli tui
bun run cli mcp
```

Build with `bun run build`, then run `bun dist/cli.js discover`. `discover` publishes input and output schemas, errors and execution conventions. Commands accept `--input`, `--file` or `--stdin`. Results are JSON; watches emit NDJSON. Errors include a stable code and exit with status 1. MCP uses stdio and the same catalog.

## Wallets

```sh
bun run cli wallet connect --browser --chain 8453 --name main
bun run cli wallet connect --chain 8453 --name mobile
bun run cli wallet connect --smart --chain 8453 --name smart
bun run cli wallet status
bun run cli wallet select --name main
bun run cli wallet disconnect --name main
```

Browser connection discovers injected wallets with EIP-6963 and prioritizes Rabby, matching Aero's connection flow. WalletConnect supplies the mobile wallet URI and QR. Smart connection opens BeeGreat's `/evm-wallet` page with its existing Clerk login and Crossmint project. That page requires deployment configuration described in [smart-wallet setup](./docs/24-evm-smart-wallets.md).

The browser bridge binds an exact origin, random token, chain and account. It listens only on loopback. It transfers requests and results, never Clerk JWTs or private keys. Pairing expires after two minutes for injected wallets and ten minutes for smart-wallet login. Each signing request expires after five minutes. Identity files use mode `0600`. The TUI keeps a connection open; separate CLI processes reconnect when needed. Disconnect removes local connection data, not the wallet or its assets.

Interactive wallets remain interactive with `--yolo`. A browser passkey still requires its owner's approval. An agent can use an explicitly provisioned SDK signer or `EVM_PRIVATE_KEY` in its environment for unattended execution. Keys are never accepted as CLI arguments or written to the journal. This package does not silently delegate a user's smart wallet to an agent.

## Reads and writes

```sh
bun run cli read --input '{"chainId":8453,"address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","signatures":["function decimals() view returns (uint8)"],"functionName":"decimals"}'
bun run cli prepare-call --file transaction.json
bun run cli execute --input '{"id":"PLAN_ID"}' --yolo
bun run cli status --input '{"id":"PLAN_ID"}'
```

Supply an ABI or human-readable signatures. Verified ABI discovery requires an Etherscan key. Automatic proxy lookup covers the EIP-1967 implementation slot; other proxy forms need an explicit ABI. Historical reads require archive RPC support. JSON quantities use decimal strings and native values use wei. `units` rejects fractional precision loss.

Prepare with the exact chain, account, target, calldata, value and one idempotency key per intended action. Review the resulting plan, then execute using its fingerprint or `--yolo`. Execution rechecks the chain, account, simulation, expiry and configured policy. YOLO skips the toolkit approval prompt for that invocation only. It never changes those checks or the wallet's own authorization.

## Socket swaps and bridging

`socket-chains`, `socket-tokens` and `socket-quote` use Socket V3's public endpoint without a key. `swap` requests a same-chain route. `bridge-prepare` binds one returned route to its exact account, recipient, tokens, amounts, slippage, deadline and calldata. Read its schema with `discover` rather than inventing provider fields.

`bridge-run` executes the stored approval and route workflow. `bridge-status` and `bridge-wait` track the original quote and source transaction. The package checks the destination receipt and ERC-20 transfer recipient, token and minimum amount before marking settlement verified. Source inclusion alone never proves settlement. Native transfers executed internally by a bridge need traces and remain unverified here. Public endpoint availability and route liquidity are provider-dependent.

Approvals use exact amounts. Workflows are sequential and are not atomic. A route that expires after an approval needs a fresh reviewed quote and key. Keep the prior bridge ID for reconciliation; never retry a timed-out bridge under a new key without checking it.

## Commands

| Area | Commands |
| --- | --- |
| Contracts and data | `inspect`, `read`, `decode`, `identity`, `resolve-name`, `balance`, `token`, `block`, `transaction`, `logs` |
| Execution | `prepare`, `prepare-call`, `execute`, `status`, `wait`, `cancel`, `operations`, `replace`, `attach-transaction` |
| Wallets | `wallet`, `wallets`, `wallet-connect`, `wallet-select`, `wallet-disconnect`, `wallet-capabilities`, `sign-typed-data` |
| Assets | `transfer`, `approve`, `revoke`, `allowance`, `wrap`, `units` |
| Simulation and policy | `capabilities`, `simulate`, `policy-create`, `policy-revoke`, `policies` |
| Workflows | `workflow-create`, `workflow-run`, `workflow-status`, `workflow-cancel`, `verify-outcome` |
| Bridge and swap | `socket-chains`, `socket-tokens`, `socket-quote`, `swap`, `bridge-prepare`, `bridge-run`, `bridge-status`, `bridge-wait` |
| Wallet batches | `batch-prepare`, `batch-run`, `batch-status` |
| Protocol and indexed data | `aero`, `vault`, `lending`, `portfolio` |
| Monitoring | `watch`, `watch-contract`, `monitor-create`, `monitor-poll`, `monitor-ack`, `monitor-pause`, `monitors` |
| Saved contracts | `workspace`, `save`, `remove` |

Aero reads and plans use the existing Sugar integration. Vault and lending helpers prepare ABI calls. Indexed portfolios expose provider and coverage information, with Blockscout support limited to configured networks. RPC alone cannot enumerate every asset or allowance. Log pagination exposes a continuation block and offset. Monitors retain cursors and acknowledgements across restarts.

## Execution recovery

EOA signing persists bytes, hash and nonce before broadcast. `status` is read-only. Retrying `execute` reconciles or broadcasts those same bytes. Explicit `replace` plans support repricing or nonce cancellation and check whether the original already won. Browser response loss can be recovered with `attach-transaction`, which verifies the supplied transaction against the stored plan.

Crossmint execution prepares without approval, verifies the single call, then persists the provider ID and UserOperation hash before requesting approval. Re-execution resumes that provider ID. Confirmation requires the canonical receipt and a matching UserOperation event from a known EntryPoint, including its inner success flag. A reorg returns the operation to pending. A provider failure or an expired unresolved approval remains visible and blocks new account submissions until reconciled; there is no provider cancellation endpoint in this adapter.

EIP-5792 batches persist the requested batch ID before submission and recover through wallet status. Atomicity, chain and receipts must match. Unsupported RPC simulation or wallet capabilities fail explicitly.

SQLite coordinates processes sharing one database. Unresolved operations block new submissions for that account and chain. Separate databases, hosts and external wallet activity do not share these locks. Preserve the journal after an uncertain response. It contains broadcastable signed bytes protected by file permissions; public results omit those bytes.

Local policies constrain chains, recipients, contract selectors, expiry, fees and conservative native/ERC-20 budgets. An allowance reserves its full amount. Failed or unresolved actions do not release reservations automatically. Arbitrary protocol-internal token movements are not a generic token budget. Crossmint and wallet batches reject these EOA policy bounds; unattended smart signers need separately configured on-chain scopes. The UI does not provision scoped agent signers.

## SDK

```ts
import { ManagedRuntime } from 'effect'
import { dispatch, runtimeLayer } from '@beegreat/evm'

const runtime = ManagedRuntime.make(runtimeLayer({ database: './evm.sqlite' }))
try {
  const result = await runtime.runPromise(dispatch('balance', {
    chainId: 8453,
    address: '0x1111111111111111111111111111111111111111',
  }))
} finally {
  await runtime.dispose()
}
```

Exported services and workflows support typed composition. `runtimeLayer` accepts a Viem local account or an external signer. `crossmintAdapter` adapts an already configured Crossmint wallet. Credentials, custody and signer scopes remain the caller's responsibility. Effect streams implement bounded watches and polling.

## Configuration

| Setting | Meaning |
| --- | --- |
| `EVM_RPC_URL` / `--rpc` | RPC override, checked against the requested chain |
| `EVM_RPC_URLS` | JSON map of chain IDs to fallback URL arrays |
| `EVM_DATABASE` / `--database` | Journal path; defaults to `~/.local/share/bee-evm/operations.sqlite` |
| `EVM_PRIVATE_KEY` | Optional unattended EOA signer |
| `EVM_POLICY` | Mandatory policy for the configured signer |
| `EVM_ETHERSCAN_API_KEY` | Verified ABI discovery |
| `WALLETCONNECT_PROJECT_ID` | Optional override of BeeGreat's existing public project ID |
| `EVM_SMART_WALLET_URL` | Hosted login page; defaults to `https://beegreat.app/evm-wallet` |
| `SOCKET_API_KEY` | Optional Socket API key |
| `SOCKET_API_URL`, `SOCKET_AFFILIATE` | Endpoint override and optional affiliate |

Built-in RPCs cover Ethereum, Base, Sepolia, Base Sepolia, Arbitrum, Optimism, Polygon, BNB Chain and local Anvil. Crossmint support is narrower and uses its explicit chain map. Other chains need an RPC URL. Hosted wallet pages require HTTPS, with loopback HTTP allowed for development. Passkeys belong to their creation origin.

## TUI and verification

Ctrl+K searches commands, Ctrl+W opens wallet connection, Tab moves through fields and results, Ctrl+R runs, and Ctrl+E approves the displayed plan. Function, operation and contract pickers fill corresponding forms. Ctrl+C exits.

```sh
bun run typecheck
bun run lint
bun run test
bun run build
bun run test:e2e
```

Foundry's `forge` and `anvil` are required for end-to-end tests. Fixtures use random local keys and never mainnet funds. Results are saved in ignored `artifacts/e2e.json`. The wallet-batch test uses an explicit simulation fixture because Anvil lacks `eth_simulateV1`, while its receipts come from real Anvil transactions. Crossmint provider and UserOperation receipt tests use deterministic fixtures. Live Crossmint login, passkey enrollment, recovery and bundler submission require configured projects and remain separate acceptance checks.

EIP-1559 execution includes OP Stack L1 data fee estimates where supported. Fee estimates can change after signing. Asset-change simulation requires RPC support. Inclusion, safe and finalized blocks are distinct. Call `status` again to detect reorgs. The tool does not promise that simulation predicts every contract outcome.

The generic and Effect anti-slop rules run as errors. Effect is pinned to v4 beta.107. Reference clones remain read-only. The Crossmint SDK is Apache-2.0; existing Sugar and protocol licensing notices continue to apply.

## Standalone repository

This repository contains the toolkit at its root and its Aero dependency in `packages/sugar`. It installs without a BeeGreat checkout. Smart-wallet login uses the hosted BeeGreat web app; this repository does not duplicate BeeGreat authentication or contain its secrets. See [standalone maintenance](docs/standalone.md).
