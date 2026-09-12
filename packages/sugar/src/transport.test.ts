import { describe, expect, spyOn, test } from 'bun:test'
import { stubFetch } from './test-support'
import { createSugarFailoverTransport } from './transport'
import type { SugarRpcEvent } from './types'

describe('Sugar failover transport observability', () => {
  test('paces concurrent requests for compute-unit-limited RPCs', async () => {
    const startedAt: number[] = []
    let firstCompleted = false
    let secondStartedBeforeFirstCompleted = false
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(stubFetch(async () => {
      startedAt.push(Date.now())
      if (startedAt.length === 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 60))
        firstCompleted = true
      } else {
        secondStartedBeforeFirstCompleted = !firstCompleted
      }
      return new Response(JSON.stringify({ id: 1, jsonrpc: '2.0', result: '0xa' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }))
    try {
      const transport = createSugarFailoverTransport(
        ['https://paced.invalid'],
        { minIntervalMs: 25 },
      )({})
      await Promise.all([
        transport.request({ method: 'eth_chainId' }),
        transport.request({ method: 'eth_chainId' }),
      ])
      expect(startedAt).toHaveLength(2)
      expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(20)
      expect(secondStartedBeforeFirstCompleted).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('reports backup endpoint use without exposing URLs or request parameters', async () => {
    const requests: string[] = []
    const fakeFetch = stubFetch(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      requests.push(url)
      if (url.includes('primary')) {
        return new Response(JSON.stringify({ error: { code: -32_005, message: 'rate limited' } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 429,
        })
      }
      return new Response(JSON.stringify({ id: 1, jsonrpc: '2.0', result: '0xa' }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    })
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch)
    const events: SugarRpcEvent[] = []

    try {
      const transport = createSugarFailoverTransport(
        ['https://primary.invalid', 'https://backup.invalid'],
        { onRpcEvent: (event) => events.push(event) },
      )({})

      await expect(transport.request({ method: 'eth_chainId' })).resolves.toBe('0xa')

      expect(requests).toHaveLength(2)
      expect(events).toEqual([
        {
          attemptCount: 1,
          failoverUsed: false,
          operation: 'eth_chainId',
          phase: 'transport',
          status: 'error',
        },
        {
          attemptCount: 2,
          failoverUsed: true,
          operation: 'eth_chainId',
          phase: 'transport',
          status: 'success',
        },
      ])
      expect(events.every((event) => !('url' in event) && !('params' in event))).toBe(true)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  test('does not surface a stale allowance revert after the primary was throttled', async () => {
    const fakeFetch = stubFetch(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.includes('primary')) {
        return new Response(JSON.stringify({ error: { code: -32_005, message: 'rate limited' } }), {
          headers: { 'Content-Type': 'application/json' },
          status: 429,
        })
      }
      return new Response(JSON.stringify({
        id: 1,
        jsonrpc: '2.0',
        error: { code: 3, message: 'execution reverted: ERC20: insufficient allowance' },
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    })
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch)
    try {
      const transport = createSugarFailoverTransport([
        'https://primary.invalid',
        'https://stale.invalid',
      ])({})
      await expect(transport.request({ method: 'eth_call', params: [] }))
        .rejects.not.toThrow('insufficient allowance')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})
