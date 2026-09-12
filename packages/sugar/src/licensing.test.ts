import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import manifest from '../package.json'

const portedFiles = ['abis', 'actions', 'chains', 'client', 'config', 'helpers', 'known-tokens', 'models', 'planner', 'superswap', 'types']
const notices = ['LICENSE', 'LICENSE.Apache-2.0', 'NOTICE']

describe('license distribution', () => {
  test('retains the complete upstream Apache license', async () => {
    const bytes = new Uint8Array(await Bun.file(new URL('../LICENSE.Apache-2.0', import.meta.url)).arrayBuffer())
    const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    expect(hash).toBe('3b106e87c0610102b42d042be9c79bc967c84503')
  })

  test('includes attribution files in package distributions', async () => {
    expect(manifest.license).toBe('SEE LICENSE IN LICENSE')
    for (const file of notices) {
      expect(manifest.files).toContain(file)
      expect(await Bun.file(new URL(`../${file}`, import.meta.url)).exists()).toBe(true)
    }
    const readme = await Bun.file(new URL('../README.md', import.meta.url)).text()
    expect(readme).toContain('not affiliated with, endorsed by, sponsored by, or maintained by Aerodrome Finance')
    const notice = await Bun.file(new URL('../NOTICE', import.meta.url)).text()
    expect(notice).toContain('Copyright 2025 Velodrome Finance')
  })

  test.each(portedFiles)('%s retains upstream attribution and a change notice', async (name) => {
    const source = await Bun.file(new URL(`./${name}.ts`, import.meta.url)).text()
    const header = source.split('\n').slice(0, 3).join('\n')
    expect(header).toContain('Copyright 2025 Velodrome Finance')
    expect(header).toContain('Modified by Francesco Oddo and BeeGreat contributors')
    expect(header).toContain('Apache-2.0')
  })
})
