#!/usr/bin/env node
// MCP server over stdio, for a Claude app on the same machine as the hub (or with PIXOO_HUB_URL pointing at it).
// Usually easier: the hub serves MCP itself at http://<hub>:8787/mcp — see README「让 Claude 来控制」.
//
//   claude mcp add pixoo -- node /path/to/pixoo-hub/bin/pixoo-mcp.js
// The hub address / token come from `pixoo login` (or PIXOO_HUB_URL / PIXOO_HUB_TOKEN).

import { createInterface } from "node:readline";
import { HubClient, clientConfig } from "../src/client.js";
import { handleRpc } from "../src/mcp-tools.js";

const hub = new HubClient(clientConfig());
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  const res = await handleRpc(hub, msg);
  if (res) out(res);
});
