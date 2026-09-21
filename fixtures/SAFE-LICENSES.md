# Safe extension test bytecode

`safe-extensions.json` contains runtime bytecode read from the canonical Base deployments identified in `src/safe/deployments.json` on 2026-09-21. It is used only to reproduce these contracts on an isolated Anvil node. Production code verifies the recorded runtime hashes.

Safe Allowance 0.1.1, Safe4337Module 0.3.0, and Safe WebAuthn signer factory/P-256 verifier 0.2.1 are from https://github.com/safe-global/safe-modules. Safe contracts and modules carry LGPL-3.0-only notices. The Daimo P-256 verifier is MIT licensed, copyright 2023 Renaud Dubois and Daimo, Inc. Its license is retained in `LICENSE.P256-MIT`; LGPL and its incorporated GPL terms are retained in `LICENSE.Safe-LGPL-3.0` and `LICENSE.GPL-3.0`. Zodiac Roles 2.1.1 and its linked libraries are from https://github.com/gnosisguild/zodiac-modifier-roles under LGPL-3.0-only. Zodiac ModuleProxyFactory is from https://github.com/gnosisguild/zodiac-core under LGPL-3.0-only.

The SDK uses their published APIs and retains the upstream license in its installed dependencies. Corresponding source is available at those repositories and from the verified contract records for the addresses in the deployment manifest. This SDK is independent and is not affiliated with Safe or Gnosis Guild.

The matching verified sources and compiler settings can be downloaded from the Base explorer contract Code pages, using each address in both JSON files: `https://basescan.org/address/<address>#code`. `safe-libraries.json` also contains the Safe WebAuthn signer singleton and linked Zodiac Roles libraries, under the same upstream terms. The ERC-2470 singleton factory is published at https://eips.ethereum.org/EIPS/eip-2470. These are unmodified on-chain runtimes, not original SDK code.
