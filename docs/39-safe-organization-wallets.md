# Safe organization wallets

Safe supplies threshold authorization independently of Crossmint. A wallet can have one owner or require two of three owners. Pecu's personal Crossmint wallet remains unchanged. Multiple owners controlled by one backend secret do not provide independent custody.

The SDK verifies official Safe 1.4.1 proxy and singleton code. It accepts only verified Allowance 0.1.1, Safe 4337 0.3.0 and Zodiac Roles 2.1.1 modules. A Roles proxy must be owned by, and target, the selected Safe. Unknown modules are refused. Deployment addresses and runtime hashes are pinned in `src/safe/deployments.json`; a chain must have those exact deployments.

## Owners and transactions

All commands share the SDK, CLI, TUI and MCP catalog. Run `evm discover` for input and output schemas. Native values are wei and token amounts are base units, represented as decimal strings. Thresholds are integer owner counts.

| Command | Result |
| --- | --- |
| `safe-predict`, `safe-deploy` | Deterministic address and unsigned deployment plan |
| `safe-info` | Owners, threshold, enabled modules, nonce and observation block |
| `safe-propose`, `safe-batch-propose` | A portable, hash-bound proposal at the current Safe nonce |
| `safe-approvals`, `safe-approve` | Inspect or prepare one owner's on-chain hash approval |
| `safe-execute` | Unsigned execution plan after enough current owners approve |
| `safe-execute-signatures` | Unsigned plan using collected EOA or contract-owner signatures |
| `safe-cancel-propose` | Competing zero-value self-call at the current nonce |
| `safe-owner-propose` | Add, remove or replace an owner, or change the threshold |

Deployment and execution commands return plans for the ordinary `execute` and `status` journal workflow. Review the exact fingerprint before execution. Each owner approves the full proposal independently. Keep operation IDs and idempotency keys after timeouts; do not create another action with a fresh key.

Safe proposals bind the chain, wallet, destination, value, calldata, operation and nonce. Refund fields are zero. Ordinary calls use CALL. Batches allow up to 64 CALLs through the verified MultiSendCallOnly contract; arbitrary delegatecall and nested delegated calls are rejected. A failed batch item reverts every item.

An `approveHash` approval is permanent for that exact hash. Local cancellation does not revoke it. Owners must approve and execute a competing cancellation at the same Safe nonce to invalidate other proposals. Cancellation can lose a race. Outer plan expiry does not expire an on-chain Safe approval.

Signer replacement uses `change: { kind: "replace", owner, replacement }`. The surviving owners must still meet the current threshold. This is quorum-based recovery, not recovery after losing enough keys to fall below quorum. It keeps the Safe address, assets and threshold.

## Agent spending budgets

`safe-budget-propose` builds one owner-approved batch to enable the Allowance module, register a delegate and set a token budget. Supply `safe`, `delegate`, `token`, `amount`, `resetMinutes` and `chainId`. Use the zero token address for ETH. A zero reset interval means a one-time budget; otherwise the contract replenishes it at the specified minute interval.

`safe-budget` reads the remaining allowance and whether the module is enabled. `safe-budget-spend` prepares a transfer for the delegate account, enforcing the amount, token and remaining budget on-chain. It uses no fee token or delegated signature. Owners revoke with `safe-budget-revoke-propose`, or disable the entire module with `safe-module-propose`.

A budget limits quantity, not recipients. Use Roles when the recipient or contract action must also be restricted. Granting a budget authorizes future spending without a new owner quorum for each payment.

## Restricted contract permissions

1. Prepare and execute `safe-roles-deploy`. Its new module initially has no authority.
2. Build `safe-role-grant-propose` with the module, a nonzero bytes32 role, member and permissions. Owners approve and execute the returned batch.
3. Inspect the module with `safe-module-info`, and simulate an exact call with `safe-role-check`.
4. Prepare `safe-role-execute` as the member account. Owners can revoke membership with `safe-role-revoke-propose` or disable the module.

Each permission fixes a target and four-byte function selector. Each static ABI argument has either an exact 32-byte value or an inclusive unsigned maximum. For an ERC-20 transfer, fix argument one to the padded recipient address and cap argument two to the token amount. Aave supply can similarly fix the asset, beneficiary and referral code while capping the amount.

This first permission builder supports static ABI arguments only. It excludes dynamic tuples, arrays and bytes, native ETH transfers and delegatecall. It rejects permissions targeting the treasury or its Roles module. Token approvals can grant downstream spenders authority; use a precise spender and amount.

Updating a role changes only the listed functions. It does not erase previously granted functions or other memberships. Use a new role key when creating a separate policy. Revocation removes the specified member from that role.

For routine operations with a lower threshold, create a separate Safe and make its address the role member. That Safe proposes a CALL to the Roles module's `execTransactionWithRole`. Its own threshold authorizes the call, and the treasury's role restrictions still apply. The treasury owner threshold does not change.

## Passkeys

Import `createSafePasskey` and `signSafeWithPasskey` from `@beegreat/evm/safe/passkey-browser` in a browser. Registration uses WebAuthn P-256 with required user verification. Persist the returned credential ID and public coordinates for that user and relying-party domain. The browser and authenticator retain the private key.

Pass the public `x` and `y` coordinates to `safe-passkey-address`, then prepare and execute `safe-passkey-deploy`. The owner is a dedicated official WebAuthn signer contract. Add it through `safe-passkey-owner-propose`, approved by the existing quorum. Adding a passkey is separate from deploying its signer.

`signSafeWithPasskey` verifies the chain and full transaction hash before requesting a WebAuthn assertion. It returns contract signatures for `safe-execute-signatures`. Replace or remove a lost passkey through the ordinary owner workflow while the surviving quorum is available. No guardian recovery module or product passkey screen is included.

## Sponsored gas

The evmSDK runtime accepts `safeRelay: { chainId, bundlerUrl, paymasterUrl, sponsorshipPolicyId? }`. Wrap endpoint URLs in Effect `Redacted`. CLI configuration uses:

```dotenv
EVM_SAFE_RELAY_CHAIN_ID=84532
EVM_SAFE_BUNDLER_URL=https://your-provider/testnet-rpc
EVM_SAFE_PAYMASTER_URL=https://your-provider/testnet-rpc
# EVM_SAFE_SPONSORSHIP_POLICY_ID=your-policy-id
```

Configure the RPC for the same chain. Endpoint credentials stay out of returned errors and proposals. An existing Safe first needs the owner-approved `safe-sponsored-enable-propose`, which enables the verified module and fallback handler. A new Safe can be deployed in its first sponsored operation.

Use `safe-sponsored-propose` with `chainId`, `wallet`, CALL-only `calls` and an idempotency `key`. `wallet` is either `{ safe }` or `{ owners, threshold, saltNonce }`. The response contains the exact sponsored operation, fingerprint and ten-minute validity window. Collect signatures through `safe-sponsored-sign` using a configured local EOA, or `safe-sponsored-signature` with an externally produced SafeOp signature. A normal SafeTx signature is not a SafeOp signature.

`safe-sponsored-submit` requires the reviewed fingerprint and threshold signatures. It simulates signed EntryPoint execution before changing the operation to pending. Invalid signatures remain editable. It persists the user-operation hash before contacting the bundler, and retries reuse the same operation. After a timeout, inspect `safe-sponsored-status` first. Status verifies the on-chain EntryPoint event, sender, nonce, paymaster and canonical receipt block. Inclusion is not a finality guarantee.

`safe-sponsored-cancel` only cancels a local, unsubmitted record. It cannot revoke copies of signatures held elsewhere; those remain usable until their validity window closes or their nonce is consumed. Paymaster funding and eligibility are provider policies, not guarantees from Safe.

The dedicated personal Pimlico key is in the ignored, mode-0600 `.env.safe-testnet.json` at the source checkout root. It is not included in exports or deployments. Run the live test explicitly:

```sh
SAFE_TEST_CONFIG="$PWD/.env.safe-testnet.json" bun run test:safe:sponsored
```

The test accepts Base Sepolia only and generates ephemeral owners. Pimlico's default testnet sponsorship worked. No separate sponsorship policy was created because the dashboard required a mainnet whitelist selection even with testnets enabled. The key name alone does not enforce a testnet-only provider restriction. Mainnet sponsorship remains unconfigured.

## Pecu

Pecu exposes 25 Safe tools through the shared web/X Chat tool set, for both OpenRouter and ChatGPT inference paths. Safe configuration proposals, budgets, roles, passkey signer deployment, collected signatures and signer replacement use the same verified sender and persisted confirmation flow as existing transfers. Requests stay on Base mainnet.

Pecu independently compares planned calldata to the reviewed request. It checks the sender, zero outer value, module destination, role, inner target, amount, signature bytes and deployment configuration. Budget and token previews use token decimals. Other role calls require a verified contract ABI and describe static arguments explicitly in contract base units. Opaque ordinary Safe contract calls remain SDK-only.

The sandbox reads and prepares. It cannot sign or submit transactions. The Durable Object owns confirmation, execution locks and receipt checks. Pecu relays confirmed transactions through its existing Crossmint wallet path. Dedicated Pimlico ERC-4337 submission is available in evmSDK; its credentials and local journal are not exposed through Pecu's disposable sandbox. No production worker deployment or live Crossmint/Safe relay test is included in this release.

BeeGreat mobile, Android, CLI, iMessage, voice and Hive do not call Pecu's wallet service. They gain no separate Safe UI. No Convex, Bee UI or client wire contracts changed.

## Verification

`bun run test:e2e` runs isolated Anvil contract tests with official artifacts and ephemeral keys. The Safe tests cover independent 2-of-3 approval, replay rejection, atomic batch rollback, budget enforcement/reset/revocation, role recipient/amount/membership restrictions, lower-threshold secondary Safes, owner replacement, module disabling and real P-256 WebAuthn signature verification. Browser helpers still need a physical authenticator acceptance test; the local contract test constructs a valid WebAuthn assertion using an ephemeral P-256 key.

Pecu tests separately reject changed recipients, delegates, values, roles, call modes, signatures and owner settings. SDK type checks, lint, unit/TUI tests and builds run alongside Pecu regression tests and dry-run worker builds.

On 2026-09-21 a live Pimlico-sponsored 2-of-3 Safe deployment and zero-value call succeeded on Base Sepolia. The test rejected insufficient quorum, an invalid second signature and a changed fingerprint, then confirmed idempotent resubmission. No user funds moved.

- Safe: `0x67AC2236E0EeFDCc8d2e95f907c0e6B8787FE08a`
- [Transaction receipt](https://sepolia.basescan.org/tx/0x475b2627f342d52a61110d936165f2bf9483cc3da25d311a4ab3340bc85e4a8c)
- User operation: `0xc31b96c756f8ced53af822b667aff3f5ba4a56fc8a8f9b2fab220338faf9b2e3`

## Sources and licenses

See [Safe's spending-limit guide](https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit), [Safe Relay Kit](https://docs.safe.global/sdk/relay-kit/reference/safe-4337-pack), [Zodiac Roles](https://docs.roles.gnosisguild.org/sdk/getting-started) and [Safe signature formats](https://docs.safe.global/advanced/smart-account-signatures). Runtime dependencies retain their licenses. The test fixtures retain LGPL-3.0, GPL-3.0 and P-256 MIT notices; see `fixtures/SAFE-LICENSES.md`. This integration is independent of Safe, Crossmint, Pimlico and Gnosis Guild.
