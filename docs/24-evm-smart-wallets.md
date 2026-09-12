# EVM smart wallets with BeeGreat projects

The toolkit reuses BeeGreat's existing Clerk and Crossmint projects. `/evm-wallet` inherits the web app's Clerk provider and passes its session JWT to Crossmint's client provider. No Crossmint server secret or Clerk token is sent to the terminal.

## Identity and recovery

Clerk handles Google and account passkey login. The visible methods follow the existing Clerk instance's settings. Enable passkeys in that instance and enroll them through Clerk account management. A Google login restores the BeeGreat account session. It does not itself sign an on-chain wallet operation.

The toolkit retrieves or creates Crossmint wallets using alias `evm-toolkit`, owned by the authenticated Clerk user. BeeGreat's older wallets use `userId:<Clerk user ID>` and a server-held signer. The alias avoids changing those wallets' ownership or recovery setup. Reusing projects does not mean silently replacing an existing wallet's signer.

New toolkit wallets have an operational passkey and verified-email recovery. Creating a replacement passkey requires the configured recovery signer's approval. Crossmint supplies its email or phone OTP interface. The page displays the actual recovery types on loaded wallets and accepts existing phone recovery if configured. New wallet creation configures email only. Crossmint also documents SMS and WhatsApp recovery, but this page does not provision a new phone recovery method.

Use Add or recover wallet passkey to register a replacement. Confirm it works before removing an old passkey. Show wallet signers exposes signer types and status, and allows passkey removal when another active passkey exists. Removal requires wallet authorization. Signing out unmounts the wallet session and closes the terminal connection.

Wallet passkeys and Clerk account passkeys are separate credentials. Synced credentials may be available through Google Password Manager or iCloud Keychain. A passkey created on localhost is not a production-origin credential. Use the final HTTPS origin for production enrollment.

## Existing project configuration

1. Use the Clerk instance already configured for the target BeeGreat web deployment. Keep development and production instances distinct. Verify Google login and enable account passkeys there.
2. In the existing Crossmint project's JWT authentication settings, configure verification of that Clerk issuer and its JWKS. Use the Clerk `sub` as the stable owner identity. Do not map by email, which can change.
3. Use a Crossmint client key with JWT authentication required, the wallet read/create/transaction/signer permissions needed by the SDK, and only the permitted BeeGreat web origins. Do not expose `CROSSMINT_API_KEY` or `CROSSMINT_SIGNER_SECRET` from the backend.
4. Set `VITE_CROSSMINT_CLIENT_API_KEY` in BeeGreat web. If the integration uses a dedicated Clerk JWT template, set `VITE_CROSSMINT_JWT_TEMPLATE`. Otherwise the page uses the normal session JWT and refreshes it every 30 seconds.
5. Deploy the BeeGreat web route at `https://beegreat.app/evm-wallet`, or set `EVM_SMART_WALLET_URL` to its actual deployment URL. Do not enroll production passkeys on a temporary preview domain.

The local web check uses the existing BeeGreat development Clerk instance and displays its Google login. This checkout has no Crossmint client key. The inspected Crossmint production console belongs to the signed-in account, but its relationship to the deployed BeeGreat server key and its Clerk JWT mapping have not been verified. No production authentication settings were changed.

## Terminal flow

```sh
bun run cli wallet connect --smart --chain 8453 --name smart
```

The terminal opens the hosted page using a short-lived random pairing token. The token stays in browser session storage during OAuth redirects and is removed on disconnect or expiry. The page validates the requested chain and expected wallet before connecting. Browser local-network permission may be required to reach the loopback WebSocket.

Prepare and execute through the normal toolkit commands. Crossmint prepares an unsigned transaction first. The toolkit checks its exact single call and records the provider ID before approval. The browser displays recipient, value, calldata and fee-payer mode. Approval uses the wallet passkey. `--yolo` never bypasses that passkey or turns it into unattended signing authority.

After a timeout, query the original operation ID. Re-execution resumes the same Crossmint ID if it still awaits approval. Confirmation requires a canonical on-chain UserOperation receipt. Provider errors, unsupported chains and mismatched calls fail visibly. Unresolved expired or failed provider operations require reconciliation before another action can use that account in the same journal.

## Acceptance checks

- Same Google/Clerk account opens the same aliased wallet after logout and login.
- Existing BeeGreat server-managed wallets retain their addresses and signers.
- A testnet passkey transaction produces the expected UserOperation receipt and contract outcome.
- Disconnect during approval, reconnect and resume the original provider transaction without another transfer.
- On a second browser or device, verify email recovery, add a replacement passkey, test it, then remove the old signer.
- Reject wrong-origin pairing, a different account, a different chain and expired plans.

The adapter and receipt checks have fixture coverage. Live provider and recovery checks require configured projects and user-driven passkey enrollment. No live smart-wallet transaction has been submitted as part of this implementation.

Provider references: [bring your own authentication](https://docs.crossmint.com/wallets/guides/bring-your-own-auth), [passkey signers](https://docs.crossmint.com/wallets/guides/signers/passkey), [recovery configuration](https://docs.crossmint.com/wallets/guides/signers/configure-recovery), [wallet recovery](https://docs.crossmint.com/wallets/guides/signers/wallet-recovery).
