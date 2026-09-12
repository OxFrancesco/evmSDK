import { runSugarCli } from '../src/cli'

const chain = Number(Bun.env.SUGAR_HEADLESS_CHAIN_ID ?? 1135)
const fromToken = Bun.env.SUGAR_HEADLESS_FROM_TOKEN ?? 'ETH'
const toToken = Bun.env.SUGAR_HEADLESS_TO_TOKEN ?? 'USDT'
const amount = Bun.env.SUGAR_HEADLESS_AMOUNT ?? '0.001'
const wallet = Bun.env.SUGAR_HEADLESS_WALLET ?? '0x1111111111111111111111111111111111111111'
const rpcUrl = Bun.env.SUGAR_HEADLESS_RPC_URL

const options = rpcUrl ? { rpcUrl } : {}
const invoke = async (args: string[]) => JSON.parse(await runSugarCli(args, options, () => {}))

const startedAt = performance.now()
const [pools, quote] = await Promise.all([
  invoke(['pools', `--chain=${chain}`, '--limit=1']),
  invoke(['quote', `--chain=${chain}`, `--from-token=${fromToken}`, `--to-token=${toToken}`, `--amount=${amount}`, '--use-decimals']),
])
const swap = await invoke([
  'swap', `--chain=${chain}`, `--wallet=${wallet}`, `--from-token=${fromToken}`,
  `--to-token=${toToken}`, `--amount=${amount}`, '--use-decimals',
])

console.log(JSON.stringify({
  ok: true,
  mode: rpcUrl?.includes('127.0.0.1') || rpcUrl?.includes('localhost') ? 'simnet' : 'live-read-only',
  chain,
  pool: pools[0] ?? null,
  quote,
  unsigned_transactions: swap.transactions ?? swap,
  swap_quote: swap.quote ?? null,
  broadcast: false,
  elapsed_ms: Math.round(performance.now() - startedAt),
}, null, 2))
