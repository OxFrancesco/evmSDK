// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import { normalizeAddress } from './helpers'
import type { ChainId, Token } from './types'

function token(chainId: ChainId, chainName: string, symbol: string, address: string, decimals: number, wrappedTokenAddress?: string): Token {
  return {
    chainId, chainName, symbol,
    tokenAddress: wrappedTokenAddress ? address : normalizeAddress(address),
    decimals, listed: true, emerging: false,
    wrappedTokenAddress: wrappedTokenAddress ? normalizeAddress(wrappedTokenAddress) : undefined,
  }
}

export const KNOWN_TOKENS = {
  10: {
    usdc: token(10, 'OP', 'USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6),
    velo: token(10, 'OP', 'VELO', '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db', 18),
    eth: token(10, 'OP', 'ETH', 'ETH', 18, '0x4200000000000000000000000000000000000006'),
    oUsdt: token(10, 'OP', 'oUSDT', '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189', 6),
  },
  8453: {
    usdc: token(8453, 'Base', 'USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
    aero: token(8453, 'Base', 'AERO', '0x940181a94A35A4569E4529A3CDfB74e38FD98631', 18),
    eth: token(8453, 'Base', 'ETH', 'ETH', 18, '0x4200000000000000000000000000000000000006'),
  },
  1135: {
    oUsdt: token(1135, 'Lisk', 'oUSDT', '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189', 6),
    lsk: token(1135, 'Lisk', 'LSK', '0xac485391EB2d7D88253a7F1eF18C37f4242D1A24', 18),
    eth: token(1135, 'Lisk', 'ETH', 'ETH', 18, '0x4200000000000000000000000000000000000006'),
    usdt: token(1135, 'Lisk', 'USDT', '0x05D032ac25d322df992303dCa074EE7392C117b9', 6),
  },
  130: {
    eth: token(130, 'Uni', 'ETH', 'ETH', 18, '0x4200000000000000000000000000000000000006'),
    oUsdt: token(130, 'Uni', 'oUSDT', '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189', 6),
    usdc: token(130, 'Uni', 'USDC', '0x078D782b760474a361dDA0AF3839290b0EF57AD6', 6),
  },
  34443: {
    eth: token(34443, 'Mode', 'ETH', 'ETH', 18, '0x4200000000000000000000000000000000000006'),
    oUsdt: token(34443, 'Mode', 'oUSDT', '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189', 6),
    usdc: token(34443, 'Mode', 'USDC', '0xd988097fb8612cc24eec14542bc03424c656005f', 6),
  },
  252: {
    frax: token(252, 'Fraxtal', 'FRAX', 'FRAX', 18, '0xfc00000000000000000000000000000000000006'),
    oUsdt: token(252, 'Fraxtal', 'oUSDT', '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189', 6),
    frxUsd: token(252, 'Fraxtal', 'frxUSD', '0xfc00000000000000000000000000000000000001', 18),
  },
  57073: {
    eth: token(57073, 'Ink', 'ETH', 'ETH', 18, '0x4200000000000000000000000000000000000006'),
    oUsdt: token(57073, 'Ink', 'oUSDT', '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189', 6),
    usdc: token(57073, 'Ink', 'USDC', '0xf1815bd50389c46847f0bda824ec8da914045d14', 6),
  },
  1868: {
    eth: token(1868, 'Soneium', 'ETH', 'ETH', 18, '0x4200000000000000000000000000000000000006'),
    oUsdt: token(1868, 'Soneium', 'oUSDT', '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189', 6),
    usdc: token(1868, 'Soneium', 'USDC', '0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369', 6),
  },
  5330: {
    eth: token(5330, 'Superseed', 'ETH', 'ETH', 18, '0x4200000000000000000000000000000000000006'),
    oUsdt: token(5330, 'Superseed', 'oUSDT', '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189', 6),
    usdc: token(5330, 'Superseed', 'USDC', '0xc316c8252b5f2176d0135ebb0999e99296998f2e', 6),
  },
  42220: {
    celo: token(42220, 'Celo', 'CELO', '0x471ece3750da237f93b8e339c536989b8978a438', 18),
    oUsdt: token(42220, 'Celo', 'oUSDT', '0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189', 6),
    usdt: token(42220, 'Celo', 'USDT', '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', 6),
    weth: token(42220, 'Celo', 'WETH', '0xd221812de1bd094f35587ee8e174b07b6167d9af', 18),
  },
} as const

export function getKnownTokens(chainId: ChainId) {
  return KNOWN_TOKENS[chainId]
}
