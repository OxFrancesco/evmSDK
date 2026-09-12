# Standalone maintenance

BeeGreat is the source repository. This export includes the toolkit, the Aero source dependency, lint rules, tests and required license notices. The architecture documents retain monorepo paths when describing the hosted BeeGreat web integration.

Create a new snapshot from BeeGreat with `bun scripts/export-evm.mjs /absolute/path/to/new-directory`. The exporter refuses an existing destination and exports only Git-visible source files. Review the resulting diff before updating this repository; never overwrite standalone changes blindly. `SOURCE.json` records the source revision and whether uncommitted changes were included.

Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun run lint`, `bun run test`, `bun run build`, and `bun run test:e2e`. Foundry is required for end-to-end tests. `bun run test:aero` validates the bundled protocol dependency. Keep the root lockfile with each update.

The repository is public. Its visibility does not change third-party licensing terms. Read the retained Aero licensing review and NOTICE before redistributing or deploying licensed protocol-derived material.
