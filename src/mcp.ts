import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js'
import { Effect, ManagedRuntime, Schema } from 'effect'
import { commands, dispatch } from './catalog'
import { runtimeLayer } from './runtime'
import type { RuntimeOptions } from './runtime'

export async function runMcp(options: RuntimeOptions) {
  const runtime = ManagedRuntime.make(runtimeLayer({ ...options, interactive: false }))
  const server = new Server({ name: 'beegreat-evm', version: '0.2.0' }, { capabilities: { tools: {} }, instructions: 'Discover schemas before acting. Prepare transactions and review their fingerprints before execution. Reuse operation IDs after uncertain submission. Browser wallet pairing is available in the TUI.' })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: commands.map(command => ToolSchema.parse({ name: command.name, description: command.description, inputSchema: { ...command.inputSchema.schema, type: 'object', $defs: command.inputSchema.definitions } })) }))
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const input = Schema.decodeUnknownSync(Schema.Json)(request.params.arguments ?? {})
    const result = await runtime.runPromise(dispatch(request.params.name, input).pipe(Effect.match({ onSuccess: value => ({ ok: true, result: value }), onFailure: error => ({ ok: false, error: { code: error.code, message: error.message, retryable: error.retryable } }) })))
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok }
  })
  try {
    await server.connect(new StdioServerTransport())
    await new Promise<void>(resolve => { server.onclose = resolve })
  } finally { await server.close(); await runtime.dispose() }
}
