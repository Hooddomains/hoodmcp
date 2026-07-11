#!/usr/bin/env node
/**
 * Hood Domains MCP server.
 *
 * Exposes .hood name tools to any MCP client (Claude Desktop, etc.). There is no Hood backend:
 * this process talks directly to a Robinhood Chain RPC and reads/writes the on-chain contracts.
 *
 *   Read tools work out of the box.
 *   register_name is a WRITE and requires HOOD_PRIVATE_KEY (a funded Robinhood Chain key).
 *
 * Env:
 *   HOOD_RPC_URL      Robinhood Chain RPC (defaults to a public client endpoint).
 *   HOOD_PRIVATE_KEY  optional; enables register_name.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
  namehash,
  parseAbi,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const RPC = process.env.HOOD_RPC_URL;
if (!RPC) {
  console.error(
    "hood-mcp: set HOOD_RPC_URL to a Robinhood Chain (chainId 4663) RPC endpoint.\n" +
      "Note: a browser origin-allowlisted key is rejected server-side — use a server-capable key."
  );
  process.exit(1);
}

const CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};

const REGISTRY = "0xd1a6f766577a0cd3c0f9f30b4add8623a49c5e41";
const REGISTRAR = "0x59ac59d6a06689cc83b68dab07261cb25b8ca03e";
const REVERSE = "0x7614e0f829e2c7a0c093005ae887ff117d9e1df4";
const ZERO = "0x0000000000000000000000000000000000000000";
const Z32 = "0x" + "00".repeat(32);
const YEAR = 31536000n;

const REG = parseAbi([
  "function getResolver(string) view returns (address)",
  "function getTokenId(uint256) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function getExpiry(uint256) view returns (uint64)",
]);
const RES = parseAbi([
  "function addr(bytes32) view returns (address)",
  "function text(bytes32,string) view returns (string)",
]);
const RAR = parseAbi([
  "function isAvailable(string) view returns (bool)",
  "function getRegisterPrice(string,uint64) view returns (uint256,uint256)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function makeCommitment(string,address,bytes32,address,address,uint64,bytes32) pure returns (bytes32)",
  "function commit(bytes32)",
  "function register(string,address,bytes32,address,address,uint64,bytes32) payable returns (uint256)",
]);
const REV = parseAbi([
  "function nameForAddr(address) view returns (string)",
  "function setName(string)",
]);

const client = createPublicClient({ chain: CHAIN, transport: http(RPC) });

const TEXT_KEYS = [
  "url",
  "com.twitter",
  "twitter",
  "com.github",
  "email",
  "avatar",
  "description",
  "location",
];

const toLabel = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\.hood$/, "");
const ok = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});
const fail = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

async function resolverOf(label) {
  const r = await client.readContract({
    address: REGISTRY,
    abi: REG,
    functionName: "getResolver",
    args: [label],
  });
  return r && r.toLowerCase() !== ZERO ? r : null;
}

const server = new McpServer({ name: "hood-domains", version: "0.1.0" });

server.tool(
  "resolve_name",
  "Resolve a .hood name to the wallet address it points at (forward resolution).",
  { name: z.string().describe("A .hood name, e.g. 'alice.hood' or just 'alice'") },
  async ({ name }) => {
    const label = toLabel(name);
    const full = label + ".hood";
    const resolver = await resolverOf(label);
    if (!resolver) return ok({ name: full, address: null, note: "no resolver set" });
    const addr = await client.readContract({
      address: resolver,
      abi: RES,
      functionName: "addr",
      args: [namehash(full)],
    });
    return ok({ name: full, address: addr !== ZERO ? getAddress(addr) : null });
  }
);

server.tool(
  "reverse_lookup",
  "Get the primary .hood name set for a wallet address (reverse resolution).",
  { address: z.string().describe("An EVM address, 0x...") },
  async ({ address }) => {
    if (!isAddress(address)) return fail("Not a valid address.");
    const name = await client.readContract({
      address: REVERSE,
      abi: REV,
      functionName: "nameForAddr",
      args: [getAddress(address)],
    });
    return ok({ address: getAddress(address), primaryName: name || null });
  }
);

server.tool(
  "get_text",
  "Read a single text record for a .hood name (any key, e.g. 'twitter', 'url', 'avatar').",
  { name: z.string(), key: z.string() },
  async ({ name, key }) => {
    const label = toLabel(name);
    const full = label + ".hood";
    const resolver = await resolverOf(label);
    if (!resolver) return ok({ name: full, key, value: null, note: "no resolver" });
    const value = await client.readContract({
      address: resolver,
      abi: RES,
      functionName: "text",
      args: [namehash(full), key],
    });
    return ok({ name: full, key, value: value || null });
  }
);

server.tool(
  "get_records",
  "Read a .hood name's records: the wallet it points at plus common text records.",
  { name: z.string() },
  async ({ name }) => {
    const label = toLabel(name);
    const full = label + ".hood";
    const resolver = await resolverOf(label);
    if (!resolver) return ok({ name: full, resolver: null, records: {} });
    const node = namehash(full);
    const addr = await client
      .readContract({ address: resolver, abi: RES, functionName: "addr", args: [node] })
      .catch(() => ZERO);
    const entries = await Promise.all(
      TEXT_KEYS.map((k) =>
        client
          .readContract({ address: resolver, abi: RES, functionName: "text", args: [node, k] })
          .then((v) => [k, v])
          .catch(() => [k, ""])
      )
    );
    const records = Object.fromEntries(entries.filter(([, v]) => v));
    return ok({
      name: full,
      resolver: getAddress(resolver),
      address: addr !== ZERO ? getAddress(addr) : null,
      records,
    });
  }
);

server.tool(
  "check_availability",
  "Check whether a .hood label is available and its price for a given number of years.",
  { label: z.string(), years: z.number().int().positive().optional() },
  async ({ label, years = 1 }) => {
    const l = toLabel(label);
    const available = await client.readContract({
      address: REGISTRAR,
      abi: RAR,
      functionName: "isAvailable",
      args: [l],
    });
    let priceEth = null;
    try {
      const [base, premium] = await client.readContract({
        address: REGISTRAR,
        abi: RAR,
        functionName: "getRegisterPrice",
        args: [l, BigInt(Math.max(1, years)) * YEAR],
      });
      priceEth = formatEther(base + premium);
    } catch {
      /* unpriceable */
    }
    return ok({ name: l + ".hood", available, years, priceEth });
  }
);

server.tool(
  "name_info",
  "Get the owner, expiry, resolver, and tokenId of a registered .hood name.",
  { name: z.string() },
  async ({ name }) => {
    const label = toLabel(name);
    const full = label + ".hood";
    const labelhash = BigInt(keccak256(toBytes(label)));
    const tokenId = await client.readContract({
      address: REGISTRY,
      abi: REG,
      functionName: "getTokenId",
      args: [labelhash],
    });
    const [owner, expiry] = await Promise.all([
      client
        .readContract({ address: REGISTRY, abi: REG, functionName: "ownerOf", args: [tokenId] })
        .catch(() => ZERO),
      client
        .readContract({ address: REGISTRY, abi: REG, functionName: "getExpiry", args: [tokenId] })
        .catch(() => 0n),
    ]);
    const resolver = await resolverOf(label);
    const registered = owner !== ZERO;
    return ok({
      name: full,
      registered,
      owner: registered ? getAddress(owner) : null,
      expiry: Number(expiry) > 0 ? new Date(Number(expiry) * 1000).toISOString() : null,
      resolver: resolver ? getAddress(resolver) : null,
      tokenId: tokenId.toString(),
    });
  }
);

server.tool(
  "register_name",
  "Register an available .hood name (WRITE, spends ETH). Requires HOOD_PRIVATE_KEY. Runs commit -> wait ~60s -> register; takes ~70s.",
  {
    label: z.string(),
    years: z.number().int().positive().optional(),
    owner: z.string().optional().describe("Recipient; defaults to the signer's address"),
  },
  async ({ label, years = 1, owner }) => {
    const pk = process.env.HOOD_PRIVATE_KEY;
    if (!pk)
      return fail(
        "register_name is disabled. Set HOOD_PRIVATE_KEY (a funded Robinhood Chain key) to enable it. Read-only tools work without it."
      );
    const l = toLabel(label);
    const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
    const recipient = owner && isAddress(owner) ? getAddress(owner) : account.address;
    const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
    const duration = BigInt(Math.max(1, years)) * YEAR;

    const available = await client.readContract({
      address: REGISTRAR,
      abi: RAR,
      functionName: "isAvailable",
      args: [l],
    });
    if (!available) return fail(`${l}.hood is not available.`);

    const [base, premium] = await client.readContract({
      address: REGISTRAR,
      abi: RAR,
      functionName: "getRegisterPrice",
      args: [l, duration],
    });
    const value = base + premium;

    const secret = "0x" + randomBytes(32).toString("hex");
    const commitment = await client.readContract({
      address: REGISTRAR,
      abi: RAR,
      functionName: "makeCommitment",
      args: [l, recipient, secret, ZERO, ZERO, duration, Z32],
    });
    const commitTx = await wallet.writeContract({
      address: REGISTRAR,
      abi: RAR,
      functionName: "commit",
      args: [commitment],
    });
    await client.waitForTransactionReceipt({ hash: commitTx });

    const minAge = await client.readContract({
      address: REGISTRAR,
      abi: RAR,
      functionName: "MIN_COMMITMENT_AGE",
    });
    await new Promise((r) => setTimeout(r, (Number(minAge) + 3) * 1000));

    const registerTx = await wallet.writeContract({
      address: REGISTRAR,
      abi: RAR,
      functionName: "register",
      args: [l, recipient, secret, ZERO, ZERO, duration, Z32],
      value,
    });
    const receipt = await client.waitForTransactionReceipt({ hash: registerTx });

    return ok({
      name: l + ".hood",
      status: receipt.status,
      owner: recipient,
      years,
      paidEth: formatEther(value),
      commitTx,
      registerTx,
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`hood-domains MCP server ready (RPC ${new URL(RPC).host})`);
