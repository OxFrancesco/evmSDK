# General EVM toolkit

`packages/evm` contains the `@beegreat/evm` Effect SDK, JSON CLI, OpenTUI application and MCP server. [Package documentation](../README.md) covers commands, execution, Socket, recovery and configuration.

Agents discover versioned schemas before calling commands. Quantities use decimal strings. Writes follow preparation, simulation, approval, persisted submission and receipt reconciliation. `--yolo` skips toolkit approval for that invocation. It cannot supply missing wallet authority or bypass a passkey.

Browser wallet connection uses the same EIP-6963 and loopback approach as Aero. WalletConnect handles mobile wallets. Crossmint smart wallets open the existing BeeGreat web app and Clerk login. They share BeeGreat's Crossmint project through a separate `evm-toolkit` wallet alias. [Smart-wallet setup](24-evm-smart-wallets.md) explains identity, passkeys and recovery.

Socket V3 supplies swap and bridge quotes through its public endpoint. The toolkit persists an exact route and approvals, executes each step once and tracks both chains. A completed source transaction cannot prove destination delivery. ERC-20 settlement checks the destination receipt and recipient transfer amount. Internal native transfers remain unverified without traces.

Effect owns services, errors, schemas, configuration, resource lifetime and polling. Viem supplies ABI encoding, RPC and transaction verification. SQLite journals operations and coordinates processes using the same database. Crossmint operations journal the provider transaction ID and UserOperation hash before signing. EIP-5792 batches journal the batch ID before contacting the wallet.

## Client and deployment decisions

- SDK, CLI, TUI and MCP use the same catalog. Every command has a terminal form. Ctrl+W connects wallets and Ctrl+K searches commands.
- The new web route `/evm-wallet` provides login, passkey wallet creation, recovery, signer removal, transaction review and loopback pairing. Account management remains in Clerk's UserButton.
- Bee chat, native mobile, iMessage, voice and Hive behavior are unchanged. This toolkit does not add Bee tools or change `beeui` output. Mobile wallets can connect using WalletConnect. Loopback pairing connects a browser on the same computer as the CLI.
- OpenRouter and Codex agents call the same CLI or MCP server. No model-specific transport or authorization behavior is introduced.
- Connect has disconnect, policies have revoke, monitors have pause and resume, aliases have remove, and unsigned plans and workflows have cancel. Explicit nonce replacement supports EOA transaction cancellation. Crossmint provider cancellation is unavailable in this adapter.
- The web route needs BeeGreat's normal web deployment and client-side Crossmint configuration. No Convex schema, agent worker or iMessage deployment is required. Existing server-managed BeeGreat wallets are not migrated.

## Validation boundaries

The isolated Anvil suite exercises real local transactions with random test keys. Its batch simulation is explicitly a fixture because Anvil lacks the required RPC method. Crossmint tests cover the provider boundary, idempotent resumption, mismatched intent, expiry, canonical UserOperation receipts and reorg recovery using fixtures. They do not prove live Crossmint bundler behavior.

Public Socket quotes, Base fees, Blockscout portfolio data, ENS and Aero reads were checked live. No mainnet transactions or bridges were submitted. Live Google callback completion, wallet passkey enrollment and recovery remain deployment acceptance checks.

References were inspected with codeview. Reference clones are read-only. Owned protocol integrations retain the licensing and non-affiliation notices in the package README.
