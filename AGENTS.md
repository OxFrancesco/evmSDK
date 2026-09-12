# EVM agent contract

Use Bun. Run `bun src/cli.ts discover` before constructing a new command.

All quantities crossing JSON use decimal strings. Native values use wei. Resolve the exact chain, account, destination, calldata, and value before preparing a write. Use one idempotency key per intended action.

`--yolo` authorizes autonomous execution for one `execute` invocation. It does not bypass simulation or chain checks. Do not retry with a new key after a timeout. Inspect the persisted operation first. `status` is read-only; `execute` may rebroadcast the existing signed bytes.

Use the shared Effect workflows and schemas for SDK, CLI, and TUI behavior. Register every command's input, output, and TUI form. Preserve the state distinction between unsigned, signed but unresolved, pending, included, reverted, and cancelled.

Run package typecheck, lint, unit/TUI tests, build, and the isolated Anvil end-to-end suite. Never use a user's live signing key in tests. Keep test outputs, SQLite databases, and signed transactions out of source control.
