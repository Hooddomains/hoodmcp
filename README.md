# @hood/mcp — Hood Domains MCP server

An [MCP](https://modelcontextprotocol.io) server that gives AI agents `.hood` name tools on
Robinhood Chain.

**There is no backend to host.** This server runs on the agent's machine and talks directly to
a Robinhood Chain RPC + the on-chain contracts. Read tools work out of the box; registration
requires you to supply a funded key.

## Tools

| Tool | Type | Description |
|---|---|---|
| `resolve_name` | read | `.hood` name → the wallet it points at |
| `reverse_lookup` | read | wallet → its primary `.hood` name |
| `get_text` | read | one text record for a name (any key) |
| `get_records` | read | a name's wallet + common text records |
| `check_availability` | read | is a label free + its price |
| `name_info` | read | owner, expiry, resolver, tokenId |
| `register_name` | write | register a name (needs `HOOD_PRIVATE_KEY`) |

## Configure (Claude Desktop / any MCP client)

```jsonc
{
  "mcpServers": {
    "hood-domains": {
      "command": "npx",
      "args": ["-y", "@hood/mcp"],
      "env": {
        "HOOD_RPC_URL": "https://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY"
      }
    }
  }
}
```

Or run locally:

```bash
cd mcp
npm install
HOOD_RPC_URL=... node index.mjs
```

## Env

- `HOOD_RPC_URL` — **required.** A Robinhood Chain (chainId 4663) RPC endpoint. Use a
  **server-capable** key — a browser origin-allowlisted key (like the dapp's) is rejected
  server-side with "Unspecified origin not on whitelist".
- `HOOD_PRIVATE_KEY` — optional. A funded Robinhood Chain private key that enables
  `register_name`. **Only set this if you want the agent to spend ETH and register names.**
  Leave it unset for a safe, read-only server.

## Notes

- `register_name` runs the two-step commit→reveal flow and takes ~70s (the ~60s front-run
  protection wait); some clients may need a longer tool timeout.
- No API keys and no Hood infrastructure are required beyond your own RPC.
- Contracts (chainId 4663): registry `0xd1a6f766577a0cd3c0f9f30b4add8623a49c5e41`, registrar
  `0x59ac59d6a06689cc83b68dab07261cb25b8ca03e`, reverse registrar
  `0x7614e0f829e2c7a0c093005ae887ff117d9e1df4`. See `/llms.txt` on the site for full ABIs.
