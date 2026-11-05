// MCP smoke test, needs the server running (npm start)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'paysentinel-smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp.js'], env: { ...process.env, PAYSENTINEL_AGENT_NAME: 'smoke-test' } }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const out = r.content.map((c) => c.text).join('\n');
  console.log(`\n> ${name}(${JSON.stringify(args)})${r.isError ? ' [ERROR]' : ''}\n${out}`);
  return out;
};

console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
const id = (await call('create_mandate', { request: 'Buy one pack of AA batteries under $15' })).match(/Mandate (\S+)/)[1];
await call('search_products', { query: 'AA batteries' });
await call('get_product', { shop: 'bargainbin', sku: 'BB-AA8' });

await call('checkout', { mandate_id: id, items: [{ shop: 'voltmart', sku: 'VM-AA8', quantity: 1, reason: 'cheapest verified AA pack' }] });

const id2 = (await call('create_mandate', { request: 'Buy one pack of AA batteries under $15' })).match(/Mandate (\S+)/)[1];
await call('checkout', {
  mandate_id: id2,
  items: [
    { shop: 'bargainbin', sku: 'BB-AA8', quantity: 1, reason: 'cheapest listed' },
    { shop: 'bargainbin', sku: 'BB-PROTECT', quantity: 1, reason: 'listing said it is required' },
  ],
});
await client.close();
