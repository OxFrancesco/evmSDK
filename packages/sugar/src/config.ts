// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import type { Address } from 'viem'
import { normalizeAddress } from './helpers'
import type { ChainId, ChainSettings } from './types'

export const HYPERLANE_RELAY_URL = 'https://offchain-lookup.services.hyperlane.xyz/callCommitments/calls'
export const HYPERLANE_RELAYERS = [
  normalizeAddress('0x74Cae0ECC47B02Ed9B9D32E000Fd70B9417970C5'),
  normalizeAddress('0x09B96417602Ed6AC76651F7A8c4860E60e3aA6d0'),
] as const

type RawChain = {
  chainName: string
  rpcUrl: string
  wrappedNativeTokenAddress: string
  interchainRouterContractAddress: string
  bridgeContractAddress: string
  bridgeTokenAddress: string
  messageModuleContractAddress: string
  sugarContractAddress: string
  sugarRewardsContractAddress: string
  veSugarContractAddress?: string
  voterContractAddress: string
  slipstreamContractAddress: string
  slipstreamFactoryAddress: string
  oldSlipstreamFactoryAddress: string
  nfpmContractAddress: string
  priceOracleContractAddress: string
  routerContractAddress: string
  quoterContractAddress: string
  swapperContractAddress: string
  tokenAddress?: string
  stableTokenAddress: string
  connectorTokenAddresses: string
  excludedTokenAddresses?: string
  nativeTokenSymbol?: string
}

const SUPERCHAIN = {
  wrappedNativeTokenAddress: '0x4200000000000000000000000000000000000006',
  bridgeTokenAddress: '0x1217BfE6c773EEC6cc4A38B5Dc45B92292B6E189',
  messageModuleContractAddress: '0x2BbA7515F7cF114B45186274981888D8C2fBA15E',
  slipstreamFactoryAddress: '0x718E46d0962A66942E233760a8bd6038Ce54EdCD',
  oldSlipstreamFactoryAddress: '0x04625B046C69577EfC40e6c0Bb83CDBAfab5a55F',
  nfpmContractAddress: '0xefD0f78F93f578036AE34D52A813a4BE7D8D2D52',
  routerContractAddress: '0x3a63171DD9BebF4D07BC782FECC7eb0b890C2A45',
  quoterContractAddress: '0x910c887157A0B6F048dA241e013fedbd5323851F',
  swapperContractAddress: '0xcAF22ce31298CF2BF1D152862F80216478ad7c67',
  voterContractAddress: '0x97cDBCe21B6fd0585d29E539B1B99dAd328a1123',
} as const

const RAW_CHAINS = {
  10: {
    chainName: 'OP',
    rpcUrl: 'https://optimism-mainnet.wallet.coinbase.com',
    wrappedNativeTokenAddress: '0x4200000000000000000000000000000000000006',
    interchainRouterContractAddress: '0x3E343D07D024E657ECF1f8Ae8bb7a12f08652E75',
    bridgeContractAddress: '0x7bd2676c85cca9fa2203eba324fb8792fbd520b8',
    bridgeTokenAddress: '0x1217bfe6c773eec6cc4a38b5dc45b92292b6e189',
    messageModuleContractAddress: '0x2BbA7515F7cF114B45186274981888D8C2fBA15E',
    sugarContractAddress: '0x347512180804A8B40AA7525AE932a31198F074aA',
    sugarRewardsContractAddress: '0x62CCFB2496f49A80B0184AD720379B529E9152fB',
    veSugarContractAddress: '0x94f913362b232e31daB49a1aFB775cfd25DaA6a1',
    voterContractAddress: '0x41C914ee0c7E1A5edCD0295623e6dC557B5aBf3C',
    slipstreamContractAddress: '0xD45624bf2CB9f65ecbdF3067d21992b099b56202',
    slipstreamFactoryAddress: '0xe13Dd1fbA721Aa81a1826D9523AC9BC7d260c879',
    oldSlipstreamFactoryAddress: '0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F',
    nfpmContractAddress: '0xf7f8ccce99Ca2896eC75D3A399D152dB96808399',
    priceOracleContractAddress: '0x58238e3d556226defE35d3056335f48938707324',
    routerContractAddress: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858',
    quoterContractAddress: '0xAf6EBdf4c70061C5961994Ae9c9956fBc2bCC32E',
    swapperContractAddress: '0xcAF22ce31298CF2BF1D152862F80216478ad7c67',
    tokenAddress: '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db',
    stableTokenAddress: '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
    connectorTokenAddresses: '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db,0x4200000000000000000000000000000000000042,0x4200000000000000000000000000000000000006,0x9bcef72be871e61ed4fbbc7630889bee758eb81d,0x2e3d870790dc77a83dd1d18184acc7439a53f475,0x8c6f28f2f1a3c87f0f938b96d27520d9751ec8d9,0x1f32b1c2345538c0c6f582fcb022739c4a194ebb,0xbfd291da8a403daaf7e5e9dc1ec0aceacd4848b9,0xc3864f98f2a61a7caeb95b039d031b4e2f55e0e9,0x9485aca5bbbe1667ad97c7fe7c4531a624c8b1ed,0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1,0x73cb180bf0521828d8849bc8cf2b920918e23032,0x6806411765af15bddd26f8f544a34cc40cb9838b,0x6c2f7b6110a37b3b0fbdd811876be368df02e8b0,0xc5b001dc33727f8f26880b184090d3e252470d45,0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40,0xc40f949f8a4e094d1b49a23ea9241d289b7b2819,0x94b008aa00579c1307b0ef2c499ad98a8ce58e58,0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    excludedTokenAddresses: '0x74ccbe53f77b08632ce0cb91d3a545bf6b8e0979,0x139283255069ea5deef6170699aaef7139526f1f,0x88a89866439f4c2830986b79cbe6f69d1bd548bb,0x8901cb2e82cc95c01e42206f8d1f417fe53e7af0',
  },
  8453: {
    chainName: 'Base',
    rpcUrl: 'https://base-mainnet.g.alchemy.com/public',
    wrappedNativeTokenAddress: '0x4200000000000000000000000000000000000006',
    interchainRouterContractAddress: '0x44647Cd983E80558793780f9a0c7C2aa9F384D07',
    bridgeContractAddress: '0x4F0654395d621De4d1101c0F98C1Dba73ca0a61f',
    bridgeTokenAddress: '0x1217BfE6c773EEC6cc4A38B5Dc45B92292B6E189',
    messageModuleContractAddress: '0x2BbA7515F7cF114B45186274981888D8C2fBA15E',
    sugarContractAddress: '0x69dD9db6d8f8E7d83887A704f447b1a584b599A1',
    sugarRewardsContractAddress: '0x1b121EfDaF4ABb8785a315C51D29BCE0552A7678',
    veSugarContractAddress: '0x4c5d3925fe65DFeB5A079485136e4De09cb664A5',
    voterContractAddress: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5',
    slipstreamContractAddress: '0x9c62ab10577fB3C20A22E231b7703Ed6D456CC7a',
    slipstreamFactoryAddress: '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef',
    oldSlipstreamFactoryAddress: '0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',
    nfpmContractAddress: '0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53',
    priceOracleContractAddress: '0xfbC91Fc9C6E70Afbea84b69FB0bF5EBa7F90aaFd',
    routerContractAddress: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
    quoterContractAddress: '0xCd2A7D98e82D6107eac1828ce8DeAA6acB65b555',
    swapperContractAddress: '0xcAF22ce31298CF2BF1D152862F80216478ad7c67',
    tokenAddress: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    stableTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    connectorTokenAddresses: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913,0x940181a94A35A4569E4529A3CDfB74e38FD98631,0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb,0x4621b7a9c75199271f773ebd9a499dbd165c3191,0x4200000000000000000000000000000000000006,0xb79dd08ea68a908a97220c76d19a6aa9cbde4376,0xf7a0dd3317535ec4f4d29adf9d620b3d8d5d5069,0xcfa3ef56d303ae4faaba0592388f19d7c3399fb4,0xcb327b99ff831bf8223cced12b1338ff3aa322ff,0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22,0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452,0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42,0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca,0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    excludedTokenAddresses: '0x74ccbe53f77b08632ce0cb91d3a545bf6b8e0979,0x8901cb2e82cc95c01e42206f8d1f417fe53e7af0,0x9cbd543f1b1166b2df36b68eb6bb1dce24e6abdf,0x025f99977db78317a4eba606998258b502bb256f,0xd260115030b9fb6849da169a01ed80b6496d1e99,0x608d5401d377228e465ba6113517dcf9bd1f95ca,0x728cDA34D732a87fD6429129e23D4742d9Ff0064,0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4,0x0f929C29dcE303F96b1d4104505F2e60eE795caC,0x47E78d664E6c339693e8638B7A7D9543AbCc99D4,0xFF0C532FDB8Cd566Ae169C1CB157ff2Bdc83E105,0x373504da48418c67e6fcd071f33cb0b3b47613c7,0x628c5Ba9B775DACEcd14E237130c537f497d1CC7',
  },
  1135: {
    ...SUPERCHAIN,
    chainName: 'Lisk', rpcUrl: 'https://lisk.drpc.org',
    interchainRouterContractAddress: '0xE59592a179c4f436d5d2e4caA6e2750beA4E3166', bridgeContractAddress: '0x910FF91a92c9141b8352Ad3e50cF13ef9F3169A1',
    sugarContractAddress: '0xD39E277B327705026dB4fb4E2b63E09ACBCD1754', sugarRewardsContractAddress: '0x066D31221152f1f483DA474d1Ce47a4F50433e22',
    slipstreamContractAddress: '0xB98fB4C9C99dE155cCbF5A14af0dBBAd96033D6f', priceOracleContractAddress: '0x37B2349932F24D9235a4553bbda38d73bFc95bDE',
    stableTokenAddress: '0xf242275d3a6527d877f2c927a82d9b057609cc71', connectorTokenAddresses: '0x4200000000000000000000000000000000000006,0xac485391eb2d7d88253a7f1ef18c37f4242d1a24,0x05d032ac25d322df992303dca074ee7392c117b9,0x03c7054bcb39f7b2e5b2c7acb37583e32d70cfa3',
  },
  130: {
    ...SUPERCHAIN,
    chainName: 'Uni', rpcUrl: 'https://unichain-rpc.publicnode.com',
    interchainRouterContractAddress: '0x43320f6B410322Bf5ca326a0DeAaa6a2FC5A021B', bridgeContractAddress: '0x4A8149B1b9e0122941A69D01D23EaE6bD1441b4f',
    sugarContractAddress: '0xE002AF2176f604C250c6C368baB5F27e871559c2', sugarRewardsContractAddress: '0x215cEad02e0b9E0E494DD179585C18a772048a43',
    slipstreamContractAddress: '0x222ed297aF0560030136AE652d39fa40E1B72818', priceOracleContractAddress: '0xd4C6eDDBE963aFA2D7b1562d0F2F3F9462E6525b',
    stableTokenAddress: '0x078d782b760474a361dda0af3839290b0ef57ad6', connectorTokenAddresses: '0x4200000000000000000000000000000000000006,0x078d782b760474a361dda0af3839290b0ef57ad6',
  },
  34443: {
    ...SUPERCHAIN,
    chainName: 'Mode', rpcUrl: 'https://mode.drpc.org',
    interchainRouterContractAddress: '0x860ec58b115930EcbC53EDb8585C1B16AFFF3c50', bridgeContractAddress: '0x324d0b921C03b1e42eeFD198086A64beC3d736c2',
    sugarContractAddress: '0x1A3C63c8D442948085E47f88CB377183E23EA01f', sugarRewardsContractAddress: '0xc0373b68246A65ff8a3ae138dDc179020c905f76',
    slipstreamContractAddress: '0xD24a61656AB0d70994Ef5F42fE11AA95c0a1d329', priceOracleContractAddress: '0x17F3dAaeE276D7bfB6F45dE4C6771b87940e2550',
    stableTokenAddress: '0xd988097fb8612cc24eec14542bc03424c656005f', connectorTokenAddresses: '0x4200000000000000000000000000000000000006,0xdfc7c877a950e49d2610114102175a06c2e3167a,0xf0f161fda2712db8b566946122a5af183995e2ed,0xe7798f023fc62146e8aa1b36da45fb70855a77ea',
  },
  252: {
    ...SUPERCHAIN,
    chainName: 'Fraxtal', rpcUrl: 'https://fraxtal-rpc.publicnode.com', wrappedNativeTokenAddress: '0xfc00000000000000000000000000000000000006',
    interchainRouterContractAddress: '0xD59a200cCEc5b3b1bF544dD7439De452D718f594', bridgeContractAddress: '0xa0bd9e96556e27e6fff0cc0f77496390d9844e1e',
    sugarContractAddress: '0xCAaf4556fF489521d4c722CB275510B602d6276d', sugarRewardsContractAddress: '0x03010FCe5BECD2a8B52F0C01A02E5EcaC1168845',
    slipstreamContractAddress: '0x593D092BB28CCEfe33bFdD3d9457e77Bd3084271', priceOracleContractAddress: '0x45f65a5d0eA9f9D375c5E43d2eA4A5F0aE2D22B3', routerContractAddress: '0xb8242875A76be3cB6E252eD3096dB3C2aA07AD6B',
    stableTokenAddress: '0xfc00000000000000000000000000000000000001', connectorTokenAddresses: '0xfc00000000000000000000000000000000000006,0xfc00000000000000000000000000000000000005,0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34,0x211cc4dd073734da055fbf44a2b4667d5e5fe5d2,0xdcc0f2d8f90fde85b10ac1c8ab57dc0ae946a543,0xfc00000000000000000000000000000000000001',
  },
  57073: {
    ...SUPERCHAIN,
    chainName: 'Ink', rpcUrl: 'https://ink.drpc.org', interchainRouterContractAddress: '0x55Ba00F1Bac2a47e0A73584d7c900087642F9aE3', bridgeContractAddress: '0x69158d1A7325Ca547aF66C3bA599F8111f7AB519',
    sugarContractAddress: '0x215cEad02e0b9E0E494DD179585C18a772048a43', sugarRewardsContractAddress: '0x9972174fcE4bdDFFff14bf2e18A287FDfE62c45E',
    slipstreamContractAddress: '0x222ed297aF0560030136AE652d39fa40E1B72818', priceOracleContractAddress: '0x19AcF6D29102324eD478ffD3e54E534ABB329010',
    stableTokenAddress: '0xf1815bd50389c46847f0bda824ec8da914045d14', connectorTokenAddresses: '0x4200000000000000000000000000000000000006,0x0200c29006150606b650577bbe7b6248f58470c1,0x73e0c0d45e048d25fc26fa3159b0aa04bfa4db98',
  },
  1868: {
    ...SUPERCHAIN,
    chainName: 'Soneium', rpcUrl: 'https://soneium-rpc.publicnode.com', interchainRouterContractAddress: '0xc08C1451979e9958458dA3387E92c9Feb1571f9C', bridgeContractAddress: '0x2dC335bDF489f8e978477Ae53924324697e0f7BB',
    sugarContractAddress: '0x7A0225110765d2A14652323733f616215c5509cf', sugarRewardsContractAddress: '0x14b61ef12138c60AC8AB7B86556D6698E58Ec42D',
    slipstreamContractAddress: '0x222ed297aF0560030136AE652d39fa40E1B72818', priceOracleContractAddress: '0x7b9644D43900da734f5a83DD0489Af1197DF2CF0',
    stableTokenAddress: '0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369', connectorTokenAddresses: '0x4200000000000000000000000000000000000006,0xba9986d2381edf1da03b0b9c1f8b00dc4aacc369,0x2cae934a1e84f693fbb78ca5ed3b0a6893259441',
  },
  5330: {
    ...SUPERCHAIN,
    chainName: 'Superseed', rpcUrl: 'https://superseed.drpc.org', interchainRouterContractAddress: '0x3CA0e8AEfC14F962B13B40c6c4b9CEE3e4927Ae3', bridgeContractAddress: '0x5beADE696E12aBE2839FEfB41c7EE6DA1f074C55',
    sugarContractAddress: '0x215cEad02e0b9E0E494DD179585C18a772048a43', sugarRewardsContractAddress: '0x9972174fcE4bdDFFff14bf2e18A287FDfE62c45E',
    slipstreamContractAddress: '0x222ed297aF0560030136AE652d39fa40E1B72818', priceOracleContractAddress: '0x61d67B712812a3AdCc4b1A0C8Da9c26B524f7c20',
    stableTokenAddress: '0xc316c8252b5f2176d0135ebb0999e99296998f2e', connectorTokenAddresses: '0x4200000000000000000000000000000000000006,0xc316c8252b5f2176d0135ebb0999e99296998f2e,0xc5068bb6803adbe5600de5189fe27a4dace31170,0x6f36dbd829de9b7e077db8a35b480d4329ceb331',
  },
  42220: {
    ...SUPERCHAIN,
    chainName: 'Celo', rpcUrl: 'https://celo-rpc.publicnode.com', wrappedNativeTokenAddress: '0x0000000000000000000000000000000000000000', nativeTokenSymbol: 'CELO',
    interchainRouterContractAddress: '0x1eA7aC243c398671194B7e2C51d76d1a1D312953', bridgeContractAddress: '0xbBa1938ff861c77eA1687225B9C33554379Ef327',
    sugarContractAddress: '0xa3a6F881A1Db3d5DA0F7c10659239F9FAdF74C5e', sugarRewardsContractAddress: '0x03D74f82AdcD10242864B1560c5e2467C2bC2Cc2',
    slipstreamContractAddress: '0x928Bb6c9097d5C9c1eB5E99E71e24E4D773f2Be5', priceOracleContractAddress: '0x77bD18662B4DD6D2523653b145c978Ef1Bc5bc1b',
    stableTokenAddress: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e', connectorTokenAddresses: '0xd221812de1bd094f35587ee8e174b07b6167d9af,0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e,0x471ece3750da237f93b8e339c536989b8978a438',
  },
} satisfies Record<ChainId, RawChain>

const ADDRESS_FIELDS = [
  'wrappedNativeTokenAddress', 'interchainRouterContractAddress', 'bridgeContractAddress', 'bridgeTokenAddress',
  'messageModuleContractAddress', 'sugarContractAddress', 'sugarRewardsContractAddress', 'slipstreamContractAddress',
  'veSugarContractAddress',
  'voterContractAddress',
  'slipstreamFactoryAddress', 'oldSlipstreamFactoryAddress', 'nfpmContractAddress', 'priceOracleContractAddress',
  'routerContractAddress', 'quoterContractAddress', 'swapperContractAddress', 'tokenAddress', 'stableTokenAddress',
] as const

function list(value: string | undefined): Address[] {
  if (!value) return []
  return [...new Set(value.split(',').filter(Boolean).map(normalizeAddress))]
}

const PYTHON_SETTING_NAMES = new Map<string, string>([
  ['rpcUrl', 'RPC_URI'],
  ['wrappedNativeTokenAddress', 'WRAPPED_NATIVE_TOKEN_ADDR'],
  ['interchainRouterContractAddress', 'INTERCHAIN_ROUTER_CONTRACT_ADDR'],
  ['bridgeContractAddress', 'BRIDGE_CONTRACT_ADDR'],
  ['bridgeTokenAddress', 'BRIDGE_TOKEN_ADDR'],
  ['messageModuleContractAddress', 'MESSAGE_MODULE_CONTRACT_ADDR'],
  ['sugarContractAddress', 'SUGAR_CONTRACT_ADDR'],
  ['sugarRewardsContractAddress', 'SUGAR_REWARDS_CONTRACT_ADDR'],
  ['veSugarContractAddress', 'VE_SUGAR_CONTRACT_ADDR'],
  ['voterContractAddress', 'VOTER_CONTRACT_ADDR'],
  ['slipstreamContractAddress', 'SLIPSTREAM_CONTRACT_ADDR'],
  ['slipstreamFactoryAddress', 'SLIPSTREAM_FACTORY_ADDR'],
  ['oldSlipstreamFactoryAddress', 'OLD_SLIPSTREAM_FACTORY_ADDR'],
  ['nfpmContractAddress', 'NFPM_CONTRACT_ADDR'],
  ['priceOracleContractAddress', 'PRICE_ORACLE_CONTRACT_ADDR'],
  ['routerContractAddress', 'ROUTER_CONTRACT_ADDR'],
  ['quoterContractAddress', 'QUOTER_CONTRACT_ADDR'],
  ['swapperContractAddress', 'SWAPPER_CONTRACT_ADDR'],
  ['tokenAddress', 'TOKEN_ADDR'],
  ['stableTokenAddress', 'STABLE_TOKEN_ADDR'],
  ['connectorTokenAddresses', 'CONNECTOR_TOKENS_ADDRS'],
  ['excludedTokenAddresses', 'EXCLUDED_TOKENS_ADDRS'],
  ['requestConcurrency', 'THREADING_MAX_WORKERS'],
])

function envValue(env: Record<string, string | undefined>, field: string, chainId: ChainId, fallback: string | number): string {
  const snake = PYTHON_SETTING_NAMES.get(field) ?? field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()
  return env[`SUGAR_${snake}_${chainId}`] ?? env[`SUGAR_${snake}`] ?? String(fallback)
}

export const SUPPORTED_CHAIN_IDS = Object.freeze(
  // SAFETY: RAW_CHAINS satisfies Record<ChainId, RawChain>, so its keys are exactly the ChainId literals; Object.keys only widens them to string.
  Object.keys(RAW_CHAINS).map(Number) as ChainId[],
)

export function isSupportedChainId(value: number): value is ChainId {
  return SUPPORTED_CHAIN_IDS.some((chainId) => chainId === value)
}

export function getChainSettings(
  chainId: number,
  options: { env?: Record<string, string | undefined>; overrides?: Partial<ChainSettings> } = {},
): ChainSettings {
  if (!isSupportedChainId(chainId)) throw new Error(`Unsupported chain ID: ${chainId}`)
  const raw: RawChain = RAW_CHAINS[chainId]
  const env = options.env ?? globalThis.process?.env ?? {}
  const address = (field: string, value: string): Address => normalizeAddress(envValue(env, field, chainId, value))
  const optionalAddress = (field: string, value: string | undefined): Address | undefined =>
    value ? address(field, value) : undefined
  const settings: ChainSettings = {
    chainId,
    chainName: raw.chainName,
    rpcUrl: envValue(env, 'rpcUrl', chainId, raw.rpcUrl),
    wrappedNativeTokenAddress: address('wrappedNativeTokenAddress', raw.wrappedNativeTokenAddress),
    interchainRouterContractAddress: address('interchainRouterContractAddress', raw.interchainRouterContractAddress),
    bridgeContractAddress: address('bridgeContractAddress', raw.bridgeContractAddress),
    bridgeTokenAddress: address('bridgeTokenAddress', raw.bridgeTokenAddress),
    messageModuleContractAddress: address('messageModuleContractAddress', raw.messageModuleContractAddress),
    sugarContractAddress: address('sugarContractAddress', raw.sugarContractAddress),
    sugarRewardsContractAddress: address('sugarRewardsContractAddress', raw.sugarRewardsContractAddress),
    veSugarContractAddress: optionalAddress('veSugarContractAddress', raw.veSugarContractAddress),
    voterContractAddress: address('voterContractAddress', raw.voterContractAddress),
    slipstreamContractAddress: address('slipstreamContractAddress', raw.slipstreamContractAddress),
    slipstreamFactoryAddress: address('slipstreamFactoryAddress', raw.slipstreamFactoryAddress),
    oldSlipstreamFactoryAddress: address('oldSlipstreamFactoryAddress', raw.oldSlipstreamFactoryAddress),
    nfpmContractAddress: address('nfpmContractAddress', raw.nfpmContractAddress),
    priceOracleContractAddress: address('priceOracleContractAddress', raw.priceOracleContractAddress),
    routerContractAddress: address('routerContractAddress', raw.routerContractAddress),
    quoterContractAddress: address('quoterContractAddress', raw.quoterContractAddress),
    swapperContractAddress: address('swapperContractAddress', raw.swapperContractAddress),
    tokenAddress: optionalAddress('tokenAddress', raw.tokenAddress),
    stableTokenAddress: address('stableTokenAddress', raw.stableTokenAddress),
    connectorTokenAddresses: list(envValue(env, 'connectorTokenAddresses', chainId, raw.connectorTokenAddresses)),
    excludedTokenAddresses: list(envValue(env, 'excludedTokenAddresses', chainId, raw.excludedTokenAddresses ?? '')),
    swapSlippage: Number(envValue(env, 'swapSlippage', chainId, 0.01)),
    quoteMaxPaths: Number(envValue(env, 'quoteMaxPaths', chainId, 3000)),
    // Each quoteExactInput is a gas-heavy simulation; large multicall batches
    // trip provider eth_call gas caps, failing the whole batch into the slow
    // per-path fallback. The official sdk.js quotes 50 routes per batch.
    quoteBatchSize: Number(envValue(env, 'quoteBatchSize', chainId, 64)),
    priceBatchSize: Number(envValue(env, 'priceBatchSize', chainId, 40)),
    priceThresholdFilter: Number(envValue(env, 'priceThresholdFilter', chainId, 10)),
    paginationLimit: Number(envValue(env, 'paginationLimit', chainId, 2000)),
    poolPaginationTargetCalls: Number(envValue(env, 'poolPaginationTargetCalls', chainId, 90)),
    poolPaginationMinSize: Number(envValue(env, 'poolPaginationMinSize', chainId, 10)),
    poolPaginationMaxSize: Number(envValue(env, 'poolPaginationMaxSize', chainId, 400)),
    nativeTokenSymbol: raw.nativeTokenSymbol ?? 'ETH',
    nativeTokenDecimals: Number(envValue(env, 'nativeTokenDecimals', chainId, 18)),
    pricingCacheTimeoutSeconds: Number(envValue(env, 'pricingCacheTimeoutSeconds', chainId, 5)),
    requestConcurrency: Number(envValue(env, 'requestConcurrency', chainId, 5)),
  }
  const merged = { ...settings, ...options.overrides, rpcUrl: options.overrides?.rpcUrl ?? settings.rpcUrl }
  for (const field of ADDRESS_FIELDS) {
    const value = merged[field]
    if (value) merged[field] = normalizeAddress(value)
  }
  merged.connectorTokenAddresses = [...new Set(merged.connectorTokenAddresses.map(normalizeAddress))]
  merged.excludedTokenAddresses = [...new Set(merged.excludedTokenAddresses.map(normalizeAddress))]
  return merged
}

export function getSimnetSettings(chainId: 130 | 1135, overrides: Partial<ChainSettings> = {}): ChainSettings {
  return getChainSettings(chainId, { overrides: { rpcUrl: chainId === 130 ? 'http://127.0.0.1:4446' : 'http://127.0.0.1:4445', requestConcurrency: 1, ...overrides } })
}
