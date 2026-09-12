// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  pad,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { abis } from './abis'
import { applySlippage, hashIcaCalls, packPath, tokenEquals } from './helpers'
import {
  ADDRESS_ZERO,
  MAX_UINT256,
  XCHAIN_GAS_LIMIT_UPPERBOUND,
  type PathHop,
  type Quote,
  type RoutePlan,
  type SuperSwapData,
  type SuperSwapDataInput,
} from './types'

export const CommandType = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  SWEEP: 0x04,
  TRANSFER_FROM: 0x07,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  BRIDGE_TOKEN: 0x12,
  EXECUTE_CROSS_CHAIN: 0x13,
  EXECUTE_SUB_PLAN: 0x21,
} as const

export const BridgeType = { HYP_XERC20: 0x01, XVELO: 0x02 } as const
export const FLAG_ALLOW_REVERT = 0x80
export const CONTRACT_BALANCE = 1n << 255n

const TRANSFER_FROM_PARAMETERS = ['address', 'address', 'uint256']

const COMMAND_PARAMETERS = new Map<number, readonly string[]>([
  [CommandType.V3_SWAP_EXACT_IN, ['address', 'uint256', 'uint256', 'bytes', 'bool', 'bool']],
  [CommandType.V3_SWAP_EXACT_OUT, ['address', 'uint256', 'uint256', 'bytes', 'bool', 'bool']],
  [CommandType.V2_SWAP_EXACT_IN, ['address', 'uint256', 'uint256', 'bytes', 'bool', 'bool']],
  [CommandType.V2_SWAP_EXACT_OUT, ['address', 'uint256', 'uint256', 'bytes', 'bool', 'bool']],
  [CommandType.WRAP_ETH, ['address', 'uint256']],
  [CommandType.UNWRAP_WETH, ['address', 'uint256']],
  [CommandType.SWEEP, ['address', 'address', 'uint256']],
  [CommandType.TRANSFER_FROM, TRANSFER_FROM_PARAMETERS],
  [CommandType.BRIDGE_TOKEN, ['uint8', 'address', 'address', 'address', 'uint256', 'uint256', 'uint32', 'bool']],
  [CommandType.EXECUTE_SUB_PLAN, ['bytes', 'bytes[]']],
  [CommandType.EXECUTE_CROSS_CHAIN, ['uint32', 'address', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'address', 'bytes']],
])

export class RoutePlanner {
  private commandBytes: number[] = []
  readonly inputs: Hex[] = []

  addCommand(command: number, parameters: unknown[], allowRevert = false): this {
    const types = COMMAND_PARAMETERS.get(command)
    if (!types) throw new Error(`Unsupported route command: ${command}`)
    // SAFETY: callers supply parameter values matching the command's ABI type list, which viem cannot verify for a dynamically parsed parameter tuple.
    this.inputs.push(encodeAbiParameters(parseAbiParameters(types.join(',')), parameters as never))
    this.commandBytes.push(command | (allowRevert ? FLAG_ALLOW_REVERT : 0))
    return this
  }

  get commands(): Hex {
    return toHex(Uint8Array.from(this.commandBytes))
  }

  toPlan(): RoutePlan {
    return { commands: this.commands, inputs: [...this.inputs] }
  }
}

type HopGroup = [PathHop, ...PathHop[]]
function groupPath(path: PathHop[]): HopGroup[] {
  const groups: HopGroup[] = []
  for (const hop of path) {
    const last = groups.at(-1)
    if (!last || last[0].pool.isCl !== hop.pool.isCl) groups.push([hop])
    else last.push(hop)
  }
  return groups
}

export function setupPlanner(
  quote: Quote,
  slippage: number,
  account: Address,
  routerAddress: Address,
  factories: { newFactory?: Address; oldFactory?: Address } = {},
): RoutePlan {
  const planner = new RoutePlanner()
  const minAmountOut = applySlippage(quote.amountOut, slippage)
  const newFactory = factories.newFactory ?? quote.input.slipstreamFactoryAddress
  const oldFactory = factories.oldFactory ?? quote.input.oldSlipstreamFactoryAddress
  let payerIsUser = quote.input.amountIn !== CONTRACT_BALANCE

  if (quote.input.fromToken.wrappedTokenAddress) {
    planner.addCommand(CommandType.WRAP_ETH, [routerAddress, quote.input.amountIn])
    payerIsUser = false
  }

  const groups = groupPath(quote.input.path)
  if (groups.length === 0) throw new Error('quote path cannot be empty')
  const packed = (hops: PathHop[]) => packPath(hops, { forSwap: true, newFactory, oldFactory }).encoded

  if (groups.length === 1) {
    const hops = groups[0]
    if (!hops) throw new Error('quote path cannot be empty')
    planner.addCommand(hops[0].pool.isBasic ? CommandType.V2_SWAP_EXACT_IN : CommandType.V3_SWAP_EXACT_IN, [
      quote.input.toToken.wrappedTokenAddress ? routerAddress : account,
      quote.input.amountIn,
      minAmountOut,
      packed(hops),
      payerIsUser,
      false,
    ])
  } else {
    const first = groups[0]
    const last = groups.at(-1)
    if (!first || !last) throw new Error('quote path cannot be empty')
    const middle = groups.slice(1, -1)
    const next = middle[0] ?? last
    planner.addCommand(first[0].pool.isBasic ? CommandType.V2_SWAP_EXACT_IN : CommandType.V3_SWAP_EXACT_IN, [
      first[0].pool.isBasic ? routerAddress : next[0].pool.lp,
      quote.input.amountIn,
      0n,
      packed(first),
      payerIsUser,
      false,
    ])

    middle.forEach((hops, index) => {
      const following = middle[index + 1] ?? last
      planner.addCommand(hops[0].pool.isBasic ? CommandType.V2_SWAP_EXACT_IN : CommandType.V3_SWAP_EXACT_IN, [
        hops[0].pool.isBasic ? routerAddress : following[0].pool.lp,
        hops[0].pool.isBasic ? 0n : CONTRACT_BALANCE,
        0n,
        packed(hops),
        false,
        false,
      ])
    })

    planner.addCommand(last[0].pool.isBasic ? CommandType.V2_SWAP_EXACT_IN : CommandType.V3_SWAP_EXACT_IN, [
      quote.input.toToken.wrappedTokenAddress ? routerAddress : account,
      last[0].pool.isBasic ? 0n : CONTRACT_BALANCE,
      minAmountOut,
      packed(last),
      false,
      false,
    ])
  }

  if (quote.input.toToken.wrappedTokenAddress) {
    planner.addCommand(CommandType.UNWRAP_WETH, [account, minAmountOut])
  }
  return planner.toPlan()
}

function addressBytes32(address: Address): Hex {
  return pad(address, { size: 32 })
}

export function buildSuperSwapData(input: SuperSwapDataInput): SuperSwapData {
  // SAFETY: bridge tokens are ERC-20 contracts resolved by bridgeToken(), so their tokenAddress is always a 0x hex address, never a native-token symbol.
  const toBridgeTokenAddress = input.toBridgeToken.tokenAddress as Address
  // SAFETY: bridge tokens are ERC-20 contracts resolved by bridgeToken(), so their tokenAddress is always a 0x hex address, never a native-token symbol.
  const fromBridgeTokenAddress = input.fromBridgeToken.tokenAddress as Address
  const destinationQuote = input.destinationQuote
    ? { ...input.destinationQuote, input: { ...input.destinationQuote.input, amountIn: CONTRACT_BALANCE } }
    : undefined
  const swapPlan = destinationQuote
    ? setupPlanner(destinationQuote, input.slippage, input.account, input.swapperContractAddress)
    : undefined
  const calls: SuperSwapData['calls'] = []

  if (swapPlan) {
    const transferInput = encodeAbiParameters(
      parseAbiParameters(TRANSFER_FROM_PARAMETERS.join(',')),
      [toBridgeTokenAddress, input.destinationRouter, CONTRACT_BALANCE],
    )
    const fallbackInput = encodeAbiParameters(
      parseAbiParameters(TRANSFER_FROM_PARAMETERS.join(',')),
      [toBridgeTokenAddress, input.account, CONTRACT_BALANCE],
    )
    const swapCommands = concatHex([toHex(CommandType.TRANSFER_FROM, { size: 1 }), swapPlan.commands])
    const fallbackCommands = toHex(CommandType.TRANSFER_FROM, { size: 1 })
    const destinationInputs = [
      encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [swapCommands, [transferInput, ...swapPlan.inputs]]),
      encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [fallbackCommands, [fallbackInput]]),
    ]
    const destinationCommands = concatHex([
      toHex(CommandType.EXECUTE_SUB_PLAN | FLAG_ALLOW_REVERT, { size: 1 }),
      toHex(CommandType.EXECUTE_SUB_PLAN | FLAG_ALLOW_REVERT, { size: 1 }),
    ])
    calls.push(
      {
        to: addressBytes32(toBridgeTokenAddress),
        value: 0n,
        data: encodeFunctionData({ abi: abis.erc20, functionName: 'approve', args: [input.destinationRouter, MAX_UINT256] }),
      },
      {
        to: addressBytes32(input.destinationRouter),
        value: 0n,
        data: encodeFunctionData({ abi: abis.swapper, functionName: 'execute', args: [destinationCommands, destinationInputs] }),
      },
      {
        to: addressBytes32(toBridgeTokenAddress),
        value: 0n,
        data: encodeFunctionData({ abi: abis.erc20, functionName: 'approve', args: [input.destinationRouter, 0n] }),
      },
    )
  }

  const commitmentHash = hashIcaCalls(calls, input.salt)
  const needsRelay = !tokenEquals(input.toToken, input.toBridgeToken)
  const startsWithBridgeToken = tokenEquals(input.fromToken, input.fromBridgeToken) && destinationQuote !== undefined
  const planner = new RoutePlanner()
  planner.addCommand(CommandType.BRIDGE_TOKEN, [
    BridgeType.HYP_XERC20,
    needsRelay ? input.userIca : input.account,
    fromBridgeTokenAddress,
    input.originBridge,
    startsWithBridgeToken ? input.originAmount : CONTRACT_BALANCE,
    input.bridgeFee,
    input.destinationDomain,
    startsWithBridgeToken,
  ])

  if (needsRelay) {
    const hookMetadata = encodePacked(
      ['uint16', 'uint256', 'uint256', 'address'],
      [1, input.xchainFee, XCHAIN_GAS_LIMIT_UPPERBOUND, input.account],
    )
    planner.addCommand(CommandType.EXECUTE_CROSS_CHAIN, [
      input.destinationDomain,
      input.originIcaRouter,
      addressBytes32(input.destinationIcaRouter),
      addressBytes32(ADDRESS_ZERO),
      commitmentHash,
      input.xchainFee,
      input.originHook,
      hookMetadata,
    ])
  }

  return {
    destinationPlanner: planner.toPlan(),
    calls,
    originDomain: input.originDomain,
    salt: input.salt,
    needsRelay,
    commitmentHash: needsRelay ? commitmentHash : undefined,
  }
}
