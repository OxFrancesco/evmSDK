import { expect, test } from 'bun:test'
import { runNotification } from './notify'

test('notification drains pipe-sized stderr and retains a bounded diagnostic', async () => {
  const result = await runNotification([process.execPath, '-e', "process.stderr.write('x'.repeat(1024*1024));process.exitCode=1"])
  expect(result.code).toBe(1)
  expect(result.stderr.length).toBeLessThanOrEqual(4096)
  expect(result.timedOut).toBe(false)
})

test('notification kills and reaps a hung subprocess', async () => {
  const start = Date.now()
  const result = await runNotification([process.execPath, '-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], 100)
  expect(result.timedOut).toBe(true)
  expect(result.code).not.toBe(0)
  expect(Date.now() - start).toBeLessThan(3000)
})
