# Safe organization wallets

Safe provides threshold authorization independently of Crossmint. A wallet can have one owner or require, for example, two of three owners. Pecu's personal Crossmint wallet remains unchanged.

The first implementation supports official Safe 1.4.1 proxies with no enabled modules. Creation uses the official deployment registry and verifies factory and singleton bytecode against its hashes. Existing wallets must have the expected proxy bytecode and singleton. Modules are rejected because they can execute without the normal owner threshold.

## Commands

All commands are available through the SDK, CLI, TUI and MCP catalog. Transaction amounts and nonces are decimal strings. Threshold is an integer owner count. None of these commands signs automatically.

| Command | Result |
| --- | --- |
| `safe-predict` | Deterministic address and deployment status for explicit owners, threshold and salt nonce |
| `safe-deploy` | Simulated deployment plan and predicted address |
| `safe-info` | On-chain owners, threshold, nonce and observation block |
| `safe-propose` | Portable transaction containing chain, Safe, destination, value, calldata, nonce and EIP-712 hash |
| `safe-approvals` | Current owners who approved that exact transaction on-chain |
| `safe-approve` | Simulated `approveHash` plan for one owner |
| `safe-execute` | Simulated execution plan once enough on-chain approvals exist |
| `safe-cancel-propose` | A competing zero-value self-call at the current nonce |
| `safe-owner-propose` | Proposal to add/remove an owner or change the threshold |

Run `evm discover` for the complete input/output schemas. A typical sequence is:

1. Call `safe-predict` with `chainId`, `owners`, `threshold` and `saltNonce`. Preserve the salt when retrying creation.
2. Call `safe-deploy` with those fields, the deployment payer's `account`, and an idempotency `key`.
3. Review the returned plan. Call the ordinary `execute` command with its exact fingerprint and then `status` or `wait`.
4. Build a `safe-propose` transaction. Share the entire returned transaction with the other owners, not just its hash.
5. Each owner calls `safe-approve` with `chainId`, `transaction`, their own `account`, and their own `key`. Execute each returned outer plan separately.
6. Once `safe-approvals` reports the threshold, call `safe-execute`. Review and execute that outer plan. The executor need not be an owner.

Keep the operation ID after preparing any transaction. Recover using `status` and `execute` on that ID. Do not create a new key after a timeout. Proposal commands reject stale Safe nonces, including after successful execution. The ordinary operation journal remains the recovery record.

## Approval and cancellation semantics

`approveHash` records one owner's approval permanently for one exact hash. It costs gas. The implementation verifies the hash locally and against the Safe contract, and counts only approvals from current owners. Duplicate owners, altered payloads, wrong chains and stale nonces are rejected.

The Safe transaction uses CALL, zero Safe gas-refund fields and no delegatecall. This prevents a supplied proposal from silently changing refund or delegation authority. With both Safe transaction gas and gas price zero, an inner failure reverts the Safe execution instead of being reported as a successful outer transaction.

Cancelling a local unsigned outer plan does not revoke an on-chain Safe approval. To invalidate competing proposals, owners must approve and execute the cancellation proposal first. Cancellation requires the existing threshold and can lose a race to another valid proposal. Owner and threshold changes also require the existing threshold.

The toolkit's outer plan expiry is not an expiry on a Safe approval. Once recorded, an approval remains valid while the Safe nonce and owner configuration allow it.

## Pecu

The shared tool set exposes `safe_create`, `safe_info`, `safe_propose`, `safe_approvals`, `safe_approve`, `safe_execute`, `safe_cancel_propose` and `safe_owner_propose`. Requests use Base mainnet. Creation asks for explicit owner addresses and threshold. The sender's existing wallet pays deployment/relay fees; it is not automatically added as an owner.

Pecu previews native and ERC-20 transfers, ERC-20 allowances, cancellation and owner changes in human-readable form. Other Safe CALL transactions are available through evmSDK. Safe approval and execution take the full proposal, and Pecu independently checks the outer calldata against it before persisting or signing. Opaque contract calls are refused in Pecu's confirmation flow.

The sandbox can read and prepare these actions. It cannot sign. The Durable Object keeps the verified sender identity, persisted preview, confirmation, execution lock and receipt checks. The same tools and capabilities run through both configured inference paths. ChatGPT's per-user inference bridge forwards Safe reads and proposals to the same authoritative service.

A Pecu confirmation approves one owner's action. It does not count as the other owners' consent. Multiple wallets controlled by Pecu's one backend secret do not provide independent custody. Use separately controlled owner wallets and recovery credentials when that is required. This change does not migrate existing personal wallets or their recovery keys.

## Verification and release scope

`bun run test:e2e` runs the existing transaction suite plus `scripts/safe-e2e.ts`. The Safe suite uses official contract artifacts on isolated Anvil and ephemeral keys. It verifies deterministic deployment, one-owner rejection by the actual contract, execution by two contract-wallet owners, payload/chain validation, replay rejection, cancellation, owner removal and the built CLI. No production funds or user keys are used.

Pecu tests independently compare Safe calldata to the reviewed proposal and reject changed recipients, amounts, owners, thresholds, refunds, delegatecall and sender overrides.

This is local contract proof, not a live Crossmint bundler or production Pecu acceptance test. Crossmint wallets can participate by sending an ordinary `approveHash` call, but that live composition still needs funded relay verification.

Client applicability: evmSDK's CLI, TUI and MCP share the catalog. Pecu web and X Chat share the agent confirmation flow and use plain-text previews. BeeGreat mobile, Android, CLI, iMessage, voice and Hive do not call Pecu's wallet service and gain no separate organization-wallet UI from this change. No Convex or Bee UI contract changes are required.

## Sources and licenses

- [Safe approval format](https://docs.safe.global/advanced/smart-account-signatures)
- [Safe approveHash semantics](https://docs.safe.global/reference-smart-account/signatures/approveHash)
- [Official deployment registry](https://github.com/safe-global/safe-deployments)
- [Safe 1.4.1 contracts](https://github.com/safe-global/safe-smart-account/tree/v1.4.1)

The deployment registry is MIT licensed. The pinned `@safe-global/safe-contracts` package retains its LGPL-3.0 notices and contains the official artifacts used for verification. Contract sources are not copied into this repository. `OwnerWallet.sol` is an original local-test fixture. This integration is independent of Safe and Crossmint.
