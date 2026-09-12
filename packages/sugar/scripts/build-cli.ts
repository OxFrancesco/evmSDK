import { resolve } from 'node:path'

const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, '../src/cli.ts'), resolve(import.meta.dir, '../src/tui/worker.ts')],
  outdir: resolve(Bun.argv[2] ?? resolve(import.meta.dir, '../dist')),
  target: 'bun',
  packages: 'external',
  naming: '[name].js',
})
if (!result.success) throw new AggregateError(result.logs, 'Aero build failed')
for (const output of result.outputs) console.log(output.path)
