import { describe, expect, test } from 'bun:test'
import { decodeAbiParameters, parseAbiParameters, type Address } from 'viem'
import { buildSuperSwapData, setupPlanner } from './planner'
import type { LiquidityPoolForSwap, Quote, Token } from './types'

const account: Address = '0x533cf9fb379488ffe0b1065c42c744fbd4b0e1a3'
const router: Address = '0x4bF3E32de155359D1D75e8B474b66848221142fc'
const VELO_ADDRESS: Address = '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db'
const USDC_ADDRESS: Address = '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'
const velo: Token = { chainId: 10, chainName: 'OP', tokenAddress: VELO_ADDRESS, symbol: 'VELO', decimals: 18, listed: true, emerging: false }
const usdc: Token = { chainId: 10, chainName: 'OP', tokenAddress: USDC_ADDRESS, symbol: 'USDC', decimals: 6, listed: true, emerging: false }
const eth: Token = { chainId: 10, chainName: 'OP', tokenAddress: 'ETH', symbol: 'ETH', decimals: 18, listed: true, emerging: false, wrappedTokenAddress: '0x4200000000000000000000000000000000000006' }

function pool(type: number, token0Address: Address, token1Address: Address): LiquidityPoolForSwap {
  return { chainId: 10, chainName: 'OP', lp: '0xec3d9098BD40ec741676fc04D4bd26BCCF592aa3', type, token0Address, token1Address, isCl: type > 0, isStable: type >= 0 && type <= 50, isBasic: type === 0 || type === -1 }
}

function quote(fromToken: Token, toToken: Token, routePool: LiquidityPoolForSwap): Quote {
  return { input: { fromToken, toToken, path: [{ pool: routePool, reversed: false }], amountIn: 5n }, amountOut: 10n }
}

describe('route planner parity', () => {
  test('matches the Python V2 exact-input plan', () => {
    const plan = setupPlanner(quote(velo, usdc, pool(-1, VELO_ADDRESS, USDC_ADDRESS)), 0.01, account, router)
    expect(plan.commands).toBe('0x08')
    expect(plan.inputs).toEqual([
      '0x000000000000000000000000533cf9fb379488ffe0b1065c42c744fbd4b0e1a30000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000299560e827af36c94d2ac33a39bce1fe78631088db007f5c764cbc14f9669b88837ca1490cca17c316070000000000000000000000000000000000000000000000',
    ])
  })

  test('wraps native input before the V2 swap', () => {
    const plan = setupPlanner(quote(eth, usdc, pool(-1, eth.wrappedTokenAddress!, USDC_ADDRESS)), 0.01, account, router)
    expect(plan.commands).toBe('0x0b08')
    expect(plan.inputs[0]).toBe('0x0000000000000000000000004bf3e32de155359d1d75e8b474b66848221142fc0000000000000000000000000000000000000000000000000000000000000005')
  })

  test('bridges the quoted amount when the origin starts with the bridge token', () => {
    const fromBridgeToken = { ...usdc, chainId: 1135 as const, chainName: 'Lisk' }
    const toBridgeToken = { ...usdc, chainId: 130 as const, chainName: 'Uni' }
    const destinationToken = { ...velo, chainId: 130 as const, chainName: 'Uni' }
    const destinationQuote: Quote = {
      input: {
        fromToken: toBridgeToken,
        toToken: destinationToken,
        path: [{ pool: { ...pool(-1, USDC_ADDRESS, VELO_ADDRESS), chainId: 130, chainName: 'Uni' }, reversed: false }],
        amountIn: 123n,
      },
      amountOut: 456n,
    }
    const data = buildSuperSwapData({
      fromToken: fromBridgeToken,
      toToken: destinationToken,
      fromBridgeToken,
      toBridgeToken,
      account,
      userIca: '0x1111111111111111111111111111111111111111',
      userIcaBalance: 0n,
      originDomain: 1135,
      originBridge: '0x2222222222222222222222222222222222222222',
      originHook: '0x3333333333333333333333333333333333333333',
      originIcaRouter: '0x4444444444444444444444444444444444444444',
      destinationIcaRouter: '0x5555555555555555555555555555555555555555',
      destinationRouter: router,
      destinationDomain: 130,
      slippage: 0.01,
      swapperContractAddress: router,
      salt: `0x${'0'.repeat(64)}`,
      bridgeFee: 1n,
      xchainFee: 2n,
      destinationQuote,
    })
    const decoded = decodeAbiParameters(
      parseAbiParameters('uint8,address,address,address,uint256,uint256,uint32,bool'),
      data.destinationPlanner.inputs[0],
    )
    expect(decoded[4]).toBe(123n)
  })
})
