// Portions derived from the Python Sugar SDK, Copyright 2025 Velodrome Finance.
// Modified by Francesco Oddo and BeeGreat contributors: TypeScript port and subsequent changes.
// Upstream portions are licensed under Apache-2.0. See ../LICENSE.Apache-2.0 and ../NOTICE.
import type { Abi } from 'viem'
import bridgeGetFeeJson from './abis/bridge_get_fee.json'
import bridgeTransferRemoteJson from './abis/bridge_transfer_remote.json'
import erc20Json from './abis/erc20.json'
import gaugeBasicJson from './abis/gauge_basic.json'
import gaugeClJson from './abis/gauge_cl.json'
import interchainAccountRouterJson from './abis/interchain_account_router.json'
import interchainRouterJson from './abis/interchain_router.json'
import nfpmJson from './abis/nfpm.json'
import permit2Json from './abis/permit2.json'
import poolBasicJson from './abis/pool_basic.json'
import poolClJson from './abis/pool_cl.json'
import priceOracleJson from './abis/price_oracle.json'
import quoterJson from './abis/quoter.json'
import rewardsDistributorJson from './abis/rewards_distributor.json'
import routerJson from './abis/router.json'
import slipstreamJson from './abis/slipstream.json'
import sugarJson from './abis/sugar.json'
import sugarRewardsJson from './abis/sugar_rewards.json'
import swapperJson from './abis/swapper.json'
import veSugarJson from './abis/ve_sugar.json'
import voterJson from './abis/voter.json'
import votingRewardJson from './abis/voting_reward.json'
import votingEscrowJson from './abis/voting_escrow.json'

function contractAbi(artifact: readonly unknown[]): Abi {
  // SAFETY: every src/abis/*.json artifact is a compiler-emitted contract ABI array; viem cannot statically type JSON imports.
  return artifact as Abi
}

export const abis = {
  bridgeGetFee: contractAbi(bridgeGetFeeJson),
  bridgeTransferRemote: contractAbi(bridgeTransferRemoteJson),
  erc20: contractAbi(erc20Json),
  gaugeBasic: contractAbi(gaugeBasicJson),
  gaugeCl: contractAbi(gaugeClJson),
  interchainAccountRouter: contractAbi(interchainAccountRouterJson),
  interchainRouter: contractAbi(interchainRouterJson),
  nfpm: contractAbi(nfpmJson),
  permit2: contractAbi(permit2Json),
  poolBasic: contractAbi(poolBasicJson),
  poolCl: contractAbi(poolClJson),
  priceOracle: contractAbi(priceOracleJson),
  quoter: contractAbi(quoterJson),
  rewardsDistributor: contractAbi(rewardsDistributorJson),
  router: contractAbi(routerJson),
  slipstream: contractAbi(slipstreamJson),
  sugar: contractAbi(sugarJson),
  sugarRewards: contractAbi(sugarRewardsJson),
  swapper: contractAbi(swapperJson),
  veSugar: contractAbi(veSugarJson),
  voter: contractAbi(voterJson),
  votingReward: contractAbi(votingRewardJson),
  votingEscrow: contractAbi(votingEscrowJson),
} as const
