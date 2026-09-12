import { test, expect } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commands } from './catalog'

test('MCP stdio exposes the shared catalog and executes a typed command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evm-mcp-'))
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, 'cli.ts'), 'mcp', '--database', join(directory, 'state.sqlite')], stderr: 'pipe' })
  const client = new Client({ name: 'evm-test', version: '1' })
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.length).toBe(commands.length)
    expect(tools.tools.find(t => t.name === 'bridge-prepare')?.inputSchema.required).toContain('receiverAddress')
    expect(await client.callTool({ name: 'units', arguments: { amount: '2.5', decimals: 6 } })).toMatchObject({ isError: false, content: [{ type: 'text', text: '{"ok":true,"result":{"baseUnits":"2500000","decimal":"2.5","decimals":6}}' }] })
    expect(await client.callTool({ name: 'transfer', arguments: { amount: '1' } })).toMatchObject({ isError: true })
  } finally { await client.close(); await transport.close() }
})
