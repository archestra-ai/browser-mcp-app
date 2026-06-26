/**
 * @file Entry point. Runs the MCP server over Streamable HTTP (default) or
 * stdio (`--stdio`, for Claude Desktop). The Playwright browser is a module
 * singleton (see browser.ts), shared across the per-request HTTP servers.
 *
 *   tsx main.ts            # HTTP on :3001
 *   tsx main.ts --stdio    # stdio transport
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import { browserManager } from "./browser.js";
import { createServer } from "./server.js";

async function startHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3001", 10);
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "8mb" }));

  // Stateless: a fresh McpServer per request, all sharing the one browser.
  app.all("/mcp", async (req, res) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  const httpServer = app.listen(port, () => {
    console.log(
      `Playwright MCP App on http://localhost:${port}/mcp  (headless=${browserManager.headless})`,
    );
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    await browserManager.close();
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startStdio(): Promise<void> {
  // IMPORTANT: never write to stdout in stdio mode — it carries JSON-RPC.
  const server = createServer();
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await browserManager.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const run = process.argv.includes("--stdio") ? startStdio() : startHttp();
run.catch((e) => {
  console.error(e);
  process.exit(1);
});
