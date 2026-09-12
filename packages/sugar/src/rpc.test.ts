import { describe, expect, test } from 'bun:test'
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  type Address,
} from 'viem'
import { abis } from './abis'
import { SugarClient } from './client'
import { SugarRpcError } from './errors'
import type { RpcDeadline } from './internal/rpc-executor'
import { expectInstanceOf, rpcExecutorOf, stringListArgument, stubPublicClient } from './test-support'
import type { PathHop, SugarRpcEvent, Token } from './types'

const FROM_TOKEN_ADDRESS: Address = '0x2000000000000000000000000000000000000001'
const TO_TOKEN_ADDRESS: Address = '0x2000000000000000000000000000000000000002'
const POOL_LP: Address = '0x2000000000000000000000000000000000000003'
const POOL_FACTORY: Address = '0x2000000000000000000000000000000000000004'

function quoteFixture() {
  const fromToken: Token = {
    chainId: 10,
    chainName: 'OP',
    decimals: 18,
    emerging: false,
    listed: true,
    symbol: 'FROM',
    tokenAddress: FROM_TOKEN_ADDRESS,
  }
  const toToken: Token = {
    ...fromToken,
    symbol: 'TO',
    tokenAddress: TO_TOKEN_ADDRESS,
  }
  return {
    fromToken,
    toToken,
    rawPool: [
      POOL_LP,
      -1,
      fromToken.tokenAddress,
      toToken.tokenAddress,
      POOL_FACTORY,
    ],
  }
}

describe('Sugar RPC policy', () => {
  test('prefers the shortest route when its output is within configured slippage of the best quote', async () => {
    const { fromToken, rawPool, toToken } = quoteFixture()
    const direct: PathHop[] = [{
      pool: {
        chainId: 10,
        chainName: 'OP',
        factory: POOL_FACTORY,
        isBasic: true,
        isCl: false,
        isStable: false,
        lp: POOL_LP,
        token0Address: FROM_TOKEN_ADDRESS,
        token1Address: TO_TOKEN_ADDRESS,
        type: -1,
      },
      reversed: false,
    }]
    const threeHop: PathHop[] = [
      direct[0],
      { ...direct[0], pool: { ...direct[0].pool, lp: '0x2000000000000000000000000000000000000005' } },
      { ...direct[0], pool: { ...direct[0].pool, lp: '0x2000000000000000000000000000000000000006' } },
    ]
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        multicall: async () => [
          { status: 'success', result: [1_000n] },
          { status: 'success', result: [995n] },
        ],
        readContract: async (request) => {
          if (request.functionName === 'count') return 1n
          if (request.functionName === 'forSwaps') return Number(request.args?.[1]) === 0 ? [rawPool] : []
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      settings: { swapSlippage: 0.01 },
    })
    sugar.getPathsForQuote = () => [threeHop, direct]

    const quote = await sugar.getQuote(fromToken, toToken, 10n)

    expect(quote?.amountOut).toBe(995n)
    expect(quote?.input.path).toHaveLength(1)
  })

  test('caps quoted paths at quoteMaxPaths, preferring the shortest routes', async () => {
    const { fromToken, rawPool, toToken } = quoteFixture()
    const direct: PathHop[] = [{
      pool: {
        chainId: 10,
        chainName: 'OP',
        factory: POOL_FACTORY,
        isBasic: true,
        isCl: false,
        isStable: false,
        lp: POOL_LP,
        token0Address: FROM_TOKEN_ADDRESS,
        token1Address: TO_TOKEN_ADDRESS,
        type: -1,
      },
      reversed: false,
    }]
    const threeHop: PathHop[] = [
      direct[0],
      { ...direct[0], pool: { ...direct[0].pool, lp: '0x2000000000000000000000000000000000000005' } },
      { ...direct[0], pool: { ...direct[0].pool, lp: '0x2000000000000000000000000000000000000006' } },
    ]
    const quotedBatches: number[] = []
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        multicall: async (request) => {
          quotedBatches.push(request.contracts.length)
          return request.contracts.map(() => ({ status: 'success', result: [1_000n] }))
        },
        readContract: async (request) => {
          if (request.functionName === 'count') return 1n
          if (request.functionName === 'forSwaps') return Number(request.args?.[1]) === 0 ? [rawPool] : []
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      settings: { quoteMaxPaths: 2 },
    })
    sugar.getPathsForQuote = () => [threeHop, threeHop, threeHop, direct]

    const quote = await sugar.getQuote(fromToken, toToken, 10n)

    expect(quotedBatches.reduce((sum, size) => sum + size, 0)).toBe(2)
    expect(quote?.input.path).toHaveLength(1)
  })

  test('disables Viem retries on the SDK-owned transport', () => {
    const sugar = new SugarClient(10, { env: {} })
    expect(sugar.publicClient.transport.retryCount).toBe(0)
  })

  test('retries transient reads and resolves through the Promise interface', async () => {
    let attempts = 0
    const events: SugarRpcEvent[] = []
    const unavailable = new HttpRequestError({
      body: { method: 'eth_call' },
      status: 503,
      url: 'https://rpc.example.invalid/v2/test-secret-key',
    })
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async () => {
          attempts += 1
          if (attempts < 3) throw unavailable
          return 123n
        },
      }),
      onRpcEvent: (event) => events.push(event),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 2 },
    })

    await expect(sugar.getBridgeFee(130)).resolves.toBe(123n)
    expect(attempts).toBe(3)
    expect(events).toEqual([
      expect.objectContaining({
        attemptCount: 3,
        itemCount: 1,
        operation: 'quoteGasPayment',
        phase: 'read',
        status: 'success',
      }),
    ])
    expect(events[0]?.durationMs).toBeGreaterThanOrEqual(0)
    expect(Object.keys(events[0] ?? {})).not.toContain('params')
  })

  test('reports pagination page and result counts without request data', async () => {
    const events: SugarRpcEvent[] = []
    const sugar = new SugarClient(10, {
      onRpcEvent: (event) => events.push(event),
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'count') return 2n
          if (request.functionName === 'all') {
            return Number(request.args?.[1]) === 0 ? [['first'], ['second']] : []
          }
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
    })

    await expect(sugar.getRawPools()).resolves.toEqual([['first'], ['second']])

    expect(events.filter((event) => event.phase === 'pagination')).toEqual([
      expect.objectContaining({
        attemptCount: 3,
        itemCount: 2,
        operation: 'all',
        pageCount: 2,
        phase: 'pagination',
        status: 'success',
      }),
    ])
    expect(events.every((event) => !('params' in event) && !('calldata' in event))).toBe(true)
  })

  test('preserves the upstream error after transient retries are exhausted', async () => {
    let attempts = 0
    const unavailable = new HttpRequestError({
      body: { method: 'eth_call' },
      status: 503,
      url: 'https://rpc.example.invalid',
    })
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async () => {
          attempts += 1
          throw unavailable
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 2 },
    })

    const error = await sugar.getBridgeFee(130).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(attempts).toBe(3)
    expect(error).toMatchObject({
      attempts: 3,
      code: 'RPC_UNAVAILABLE',
      name: 'SugarRpcError',
      retryable: true,
    })
    expect(expectInstanceOf(error, SugarRpcError).cause).toMatchObject({
      name: 'HttpRequestError',
      status: 503,
    })
    expect(JSON.stringify(expectInstanceOf(error, SugarRpcError).cause)).not.toContain(
      'test-secret-key',
    )
  })

  test('does not retry a deterministic price-oracle revert', async () => {
    const token: Token = {
      chainId: 10,
      chainName: 'OP',
      decimals: 18,
      emerging: false,
      listed: true,
      symbol: 'TEST',
      tokenAddress: '0x2222222222222222222222222222222222222222',
    }
    const reverted = new ContractFunctionRevertedError({
      abi: abis.priceOracle,
      functionName: 'getManyRatesToEthWithCustomConnectors',
      message: 'execution reverted',
    })
    const upstream = new ContractFunctionExecutionError(reverted, {
      abi: abis.priceOracle,
      args: [[], false, [], 0],
      contractAddress: '0x3333333333333333333333333333333333333333',
      functionName: 'getManyRatesToEthWithCustomConnectors',
    })
    let attempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'tokens') return stringListArgument(request, 3).map((address) => [address, 'USDC', 6, 0n, true, false])
          attempts += 1
          throw upstream
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 3 },
    })

    const error = await sugar.getPrices([token]).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(attempts).toBe(1)
    expect(error).toBeInstanceOf(SugarRpcError)
    expect(error).toMatchObject({
      attempts: 1,
      code: 'RPC_READ_FAILED',
      operation: 'getManyRatesToEthWithCustomConnectors',
      retryable: false,
    })
    expect(expectInstanceOf(error, SugarRpcError).cause).toMatchObject({
      name: 'ContractFunctionExecutionError',
    })
  })

  test('stops scheduling queued price batches after one batch fails', async () => {
    const tokens: Token[] = [
      '0x1000000000000000000000000000000000000001',
      '0x1000000000000000000000000000000000000002',
      '0x1000000000000000000000000000000000000003',
    ].map((tokenAddress, index) => ({
      chainId: 10,
      chainName: 'OP',
      decimals: 18,
      emerging: false,
      listed: true,
      symbol: `T${index + 1}`,
      tokenAddress,
    }))
    const reverted = new ContractFunctionRevertedError({
      abi: abis.priceOracle,
      functionName: 'getManyRatesToEthWithCustomConnectors',
      message: 'execution reverted',
    })
    const upstream = new ContractFunctionExecutionError(reverted, {
      abi: abis.priceOracle,
      args: [[], false, [], 0],
      functionName: 'getManyRatesToEthWithCustomConnectors',
    })
    const started: string[] = []
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'tokens') return stringListArgument(request, 3).map((address) => [address, 'USDC', 6, 0n, true, false])
          const address = String(stringListArgument(request, 0)[0])
          started.push(address)
          if (address === tokens[0].tokenAddress) throw upstream
          if (address === tokens[1].tokenAddress) await Bun.sleep(25)
          return [1n]
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 0 },
      settings: { priceBatchSize: 1, requestConcurrency: 2 },
    })

    await expect(sugar.getPrices(tokens)).rejects.toBeInstanceOf(SugarRpcError)
    await Bun.sleep(50)
    expect(started).toEqual([tokens[0].tokenAddress, tokens[1].tokenAddress])
  })

  test('stops scheduling queued pool pages after one page fails', async () => {
    const started: number[] = []
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'count') return 25n
          const offset = Number(request.args?.[1])
          started.push(offset)
          if (offset === 0) throw new Error('malformed first page')
          if (offset === 10) await Bun.sleep(25)
          return []
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 0 },
      settings: {
        poolPaginationMaxSize: 10,
        poolPaginationMinSize: 10,
        poolPaginationTargetCalls: 90,
        requestConcurrency: 2,
      },
    })

    await expect(sugar.getRawPools()).rejects.toBeInstanceOf(SugarRpcError)
    await Bun.sleep(50)
    expect(started).toEqual([0, 10])
  })

  test('applies the same retry policy to native balance reads', async () => {
    let attempts = 0
    const unavailable = new HttpRequestError({
      body: { method: 'eth_getBalance' },
      status: 503,
      url: 'https://rpc.example.invalid',
    })
    const sugar = new SugarClient(10, {
      account: '0x1111111111111111111111111111111111111111',
      publicClient: stubPublicClient({
        getBalance: async () => {
          attempts += 1
          if (attempts < 3) throw unavailable
          return 42n
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 2 },
    })
    const native: Token = {
      chainId: 10,
      chainName: 'OP',
      decimals: 18,
      emerging: false,
      listed: true,
      symbol: 'ETH',
      tokenAddress: sugar.settings.wrappedNativeTokenAddress,
      wrappedTokenAddress: sugar.settings.wrappedNativeTokenAddress,
    }

    await expect(sugar.getTokenBalance(native)).resolves.toBe(42n)
    expect(attempts).toBe(3)
  })

  test('returns a native timeout error instead of an Effect FiberFailure', async () => {
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async () => {
          await Bun.sleep(50)
          return 123n
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 5, maxRetries: 0 },
    })

    const error = await sugar.getBridgeFee(130).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(SugarRpcError)
    expect(error).toMatchObject({
      attempts: 1,
      code: 'RPC_TIMEOUT',
      name: 'SugarRpcError',
      operation: 'quoteGasPayment',
      retryable: true,
    })
  })

  test('retries quote multicalls before using the direct-call fallback', async () => {
    const { fromToken, rawPool, toToken } = quoteFixture()
    const unavailable = new HttpRequestError({
      body: { method: 'eth_call' },
      status: 503,
      url: 'https://rpc.example.invalid',
    })
    let multicallAttempts = 0
    let directAttempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        multicall: async () => {
          multicallAttempts += 1
          if (multicallAttempts < 3) throw unavailable
          return [{ status: 'success', result: [999n] }]
        },
        readContract: async (request) => {
          if (request.functionName === 'count') return 1n
          if (request.functionName === 'forSwaps') return Number(request.args?.[1]) === 0 ? [rawPool] : []
          if (request.functionName === 'quoteExactInput') {
            directAttempts += 1
            return [111n]
          }
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 2 },
      settings: { requestConcurrency: 2 },
    })

    await expect(sugar.getQuote(fromToken, toToken, 10n)).resolves.toMatchObject({ amountOut: 999n })
    expect(multicallAttempts).toBe(3)
    expect(directAttempts).toBe(0)
  })

  test('skips the direct fallback phase when every multicall succeeds', async () => {
    const { fromToken, rawPool, toToken } = quoteFixture()
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        multicall: async () => [{ status: 'success', result: [999n] }],
        readContract: async (request) => {
          if (request.functionName === 'count') return 1n
          if (request.functionName === 'forSwaps') return Number(request.args?.[1]) === 0 ? [rawPool] : []
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 0 },
    })
    const rpc = rpcExecutorOf(sugar)
    const original = rpc.forEachReadResult
    const operations: string[] = []
    rpc.forEachReadResult = <I, A>(
      operation: string,
      items: Iterable<I>,
      task: (item: I, index: number, signal: AbortSignal) => PromiseLike<A>,
      concurrency: number,
      deadline?: RpcDeadline,
    ) => {
      operations.push(operation)
      return original(operation, items, task, concurrency, deadline)
    }

    await expect(sugar.getQuote(fromToken, toToken, 10n)).resolves.toMatchObject({ amountOut: 999n })
    expect(operations).toEqual(['quoteExactInput.multicall'])
  })

  test('falls back when a multicall returns a malformed success payload', async () => {
    const { fromToken, rawPool, toToken } = quoteFixture()
    let directAttempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        multicall: async () => [{ status: 'success', result: undefined }],
        readContract: async (request) => {
          if (request.functionName === 'count') return 1n
          if (request.functionName === 'forSwaps') return Number(request.args?.[1]) === 0 ? [rawPool] : []
          if (request.functionName === 'quoteExactInput') {
            directAttempts += 1
            return [111n]
          }
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 0 },
    })

    await expect(sugar.getQuote(fromToken, toToken, 10n)).resolves.toMatchObject({ amountOut: 111n })
    expect(directAttempts).toBe(1)
  })

  test('omits a malformed direct quote payload', async () => {
    const { fromToken, rawPool, toToken } = quoteFixture()
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        multicall: async () => { throw new Error('Multicall3 is not deployed') },
        readContract: async (request) => {
          if (request.functionName === 'count') return 1n
          if (request.functionName === 'forSwaps') return Number(request.args?.[1]) === 0 ? [rawPool] : []
          if (request.functionName === 'quoteExactInput') return undefined
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 0 },
    })

    await expect(sugar.getQuote(fromToken, toToken, 10n)).resolves.toBeUndefined()
  })

  test('does not amplify an exhausted quote rate limit through direct fallbacks', async () => {
    const { fromToken, rawPool, toToken } = quoteFixture()
    const rateLimited = new HttpRequestError({
      body: { method: 'eth_call' },
      status: 429,
      url: 'https://rpc.example.invalid',
    })
    let multicallAttempts = 0
    let directAttempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        multicall: async () => {
          multicallAttempts += 1
          throw rateLimited
        },
        readContract: async (request) => {
          if (request.functionName === 'count') return 1n
          if (request.functionName === 'forSwaps') return Number(request.args?.[1]) === 0 ? [rawPool] : []
          if (request.functionName === 'quoteExactInput') {
            directAttempts += 1
            return [111n]
          }
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 1 },
      settings: { requestConcurrency: 2 },
    })

    const error = await sugar.getQuote(fromToken, toToken, 10n).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toMatchObject({
      attempts: 2,
      code: 'RPC_RATE_LIMITED',
      name: 'SugarRpcError',
      retryable: true,
    })
    expect(multicallAttempts).toBe(2)
    expect(directAttempts).toBe(0)
  })

  test('interrupts sibling quote retries when one batch exhausts', async () => {
    const { fromToken, rawPool, toToken } = quoteFixture()
    const rateLimited = new HttpRequestError({
      body: { method: 'eth_call' },
      status: 429,
      url: 'https://rpc.example.invalid',
    })
    const slowUnavailable = new HttpRequestError({
      body: { method: 'eth_call' },
      headers: new Headers({ 'Retry-After': '0.05' }),
      status: 503,
      url: 'https://rpc.example.invalid',
    })
    let fastAttempts = 0
    let slowAttempts = 0
    let directAttempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        multicall: async (request) => {
          if (request.contracts.length === 1) {
            fastAttempts += 1
            throw rateLimited
          }
          slowAttempts += 1
          throw slowUnavailable
        },
        readContract: async (request) => {
          if (request.functionName === 'count') return 1n
          if (request.functionName === 'forSwaps') return Number(request.args?.[1]) === 0 ? [rawPool] : []
          if (request.functionName === 'quoteExactInput') {
            directAttempts += 1
            return [111n]
          }
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 2 },
      settings: { requestConcurrency: 2 },
    })
    const path: PathHop[] = [{
      pool: {
        chainId: 10,
        chainName: 'OP',
        factory: POOL_FACTORY,
        isBasic: true,
        isCl: false,
        isStable: false,
        lp: POOL_LP,
        token0Address: FROM_TOKEN_ADDRESS,
        token1Address: TO_TOKEN_ADDRESS,
        type: -1,
      },
      reversed: false,
    }]
    // 65 paths split into a full 64-path batch and a trailing 1-path batch.
    sugar.getPathsForQuote = () => Array.from({ length: 65 }, () => path)

    await expect(sugar.getQuote(fromToken, toToken, 10n)).rejects.toMatchObject({
      code: 'RPC_RATE_LIMITED',
    })
    const slowAttemptsAtReturn = slowAttempts
    await Bun.sleep(150)
    expect(fastAttempts).toBe(3)
    expect(slowAttempts).toBe(slowAttemptsAtReturn)
    expect(directAttempts).toBe(0)
  })

  test('shares one deadline across quote multicall and direct fallback', async () => {
    const { fromToken, rawPool, toToken } = quoteFixture()
    let directAttempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        multicall: async () => {
          await Bun.sleep(30)
          throw new Error('Multicall3 is not deployed')
        },
        readContract: async (request) => {
          if (request.functionName === 'count') return 1n
          if (request.functionName === 'forSwaps') return Number(request.args?.[1]) === 0 ? [rawPool] : []
          if (request.functionName === 'quoteExactInput') {
            directAttempts += 1
            await Bun.sleep(400)
            return [111n]
          }
          throw new Error(`Unexpected read: ${request.functionName}`)
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 150, maxRetries: 0 },
      settings: { requestConcurrency: 2 },
    })

    const startedAt = performance.now()
    const error = await sugar.getQuote(fromToken, toToken, 10n).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(performance.now() - startedAt).toBeLessThan(350)
    expect(error).toMatchObject({ code: 'RPC_TIMEOUT', name: 'SugarRpcError' })
    expect(directAttempts).toBe(1)
  })

  test('shares one deadline across pagination count and page reads', async () => {
    let pageAttempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'count') {
            await Bun.sleep(60)
            return 1n
          }
          pageAttempts += 1
          await Bun.sleep(100)
          return []
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 80, maxRetries: 0 },
    })

    const startedAt = performance.now()
    const error = await sugar.getRawPools().then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(performance.now() - startedAt).toBeLessThan(120)
    expect(error).toMatchObject({ code: 'RPC_TIMEOUT', name: 'SugarRpcError' })
    expect(pageAttempts).toBeGreaterThan(0)
  })

  test('evicts rejected pool caches so a recovered RPC can be retried', async () => {
    let countAttempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName !== 'count') return []
          countAttempts += 1
          if (countAttempts === 1) throw new Error('malformed count response')
          return 1n
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 0 },
    })

    await expect(sugar.getPoolCount()).rejects.toBeInstanceOf(SugarRpcError)
    await expect(sugar.getPoolCount()).resolves.toBe(1)
    expect(countAttempts).toBe(2)
  })

  test('coalesces concurrent pool-count reads', async () => {
    let countAttempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async () => {
          countAttempts += 1
          await Bun.sleep(20)
          return 1n
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 0 },
    })

    await expect(Promise.all([
      sugar.getPoolCount(),
      sugar.getPoolCount(),
      sugar.getPoolCount(),
    ])).resolves.toEqual([1, 1, 1])
    expect(countAttempts).toBe(1)
  })

  test('evicts rejected raw-pool promises so a recovered RPC can be retried', async () => {
    let pageAttempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'count') return 0n
          pageAttempts += 1
          if (pageAttempts === 1) throw new Error('malformed pool page')
          return []
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 0 },
    })

    await expect(sugar.getRawPools()).rejects.toBeInstanceOf(SugarRpcError)
    await expect(sugar.getRawPools()).resolves.toEqual([])
    expect(pageAttempts).toBe(2)
  })

  test('rejects unsafe on-chain pool counts before pagination', async () => {
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async () => BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 0 },
    })

    await expect(sugar.getPoolCount()).rejects.toThrow('safe non-negative integer')
  })

  test('caps the number of pagination requests', () => {
    const sugar = new SugarClient(10, { env: {} })
    expect(() => sugar.getPoolPaginator(4_000_000)).toThrow('at most 10000 requests')
  })

  test('rejects invalid pagination settings', () => {
    const negative = new SugarClient(10, {
      env: {},
      settings: { poolPaginationMaxSize: -1, poolPaginationMinSize: -1 },
    })
    const reversed = new SugarClient(10, {
      env: {},
      settings: { poolPaginationMaxSize: 10, poolPaginationMinSize: 20 },
    })

    expect(() => negative.getPoolPaginator(1)).toThrow('positive safe integers')
    expect(() => reversed.getPoolPaginator(1)).toThrow('minimum cannot exceed maximum')
  })

  test('returns a native pagination-bound error for a hostile RPC count', async () => {
    let pageAttempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'count') return 4_000_000n
          pageAttempts += 1
          return []
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 1_000, maxRetries: 0 },
    })

    const error = await sugar.getRawPools().then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toBeInstanceOf(RangeError)
    expect(expectInstanceOf(error, Error).name).toBe('RangeError')
    expect(pageAttempts).toBe(0)
  })

  test('honors Retry-After without exceeding the total RPC deadline', async () => {
    let attempts = 0
    const rateLimited = new HttpRequestError({
      body: { method: 'eth_call' },
      headers: new Headers({ 'Retry-After': '60' }),
      status: 429,
      url: 'https://rpc.example.invalid',
    })
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async () => {
          attempts += 1
          throw rateLimited
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 10, maxRetries: 3 },
    })

    const error = await sugar.getBridgeFee(130).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(attempts).toBe(1)
    expect(error).toMatchObject({
      attempts: 1,
      code: 'RPC_TIMEOUT',
      name: 'SugarRpcError',
    })
    expect(expectInstanceOf(error, SugarRpcError).cause).toMatchObject({
      name: 'HttpRequestError',
      status: 429,
    })
  })

  test('does not attach a recovered sibling failure to a later timeout', async () => {
    const [recoveringToken, hangingToken] = [
      '0x3000000000000000000000000000000000000001',
      '0x3000000000000000000000000000000000000002',
    ].map((tokenAddress, index): Token => ({
      chainId: 10,
      chainName: 'OP',
      decimals: 18,
      emerging: false,
      listed: true,
      symbol: `T${index + 1}`,
      tokenAddress,
    }))
    const unavailable = new HttpRequestError({
      body: { method: 'eth_call' },
      status: 503,
      url: 'https://rpc.example.invalid',
    })
    let recoveringAttempts = 0
    const sugar = new SugarClient(10, {
      publicClient: stubPublicClient({
        readContract: async (request) => {
          if (request.functionName === 'tokens') return stringListArgument(request, 3).map((address) => [address, 'USDC', 6, 0n, true, false])
          const address = String(stringListArgument(request, 0)[0])
          if (address === recoveringToken.tokenAddress) {
            recoveringAttempts += 1
            if (recoveringAttempts === 1) throw unavailable
            return [1n]
          }
          if (address === hangingToken.tokenAddress) {
            await Bun.sleep(100)
            return [1n]
          }
          return [1n]
        },
      }),
      rpcPolicy: { baseDelayMs: 0, deadlineMs: 30, maxRetries: 1 },
      settings: { priceBatchSize: 1, requestConcurrency: 2 },
    })

    const error = await sugar.getPrices([recoveringToken, hangingToken]).then(
      () => undefined,
      (cause: unknown) => cause,
    )
    expect(error).toMatchObject({ code: 'RPC_TIMEOUT', name: 'SugarRpcError' })
    expect(expectInstanceOf(error, SugarRpcError).cause).toBeUndefined()
    expect(recoveringAttempts).toBe(2)
  })
})
