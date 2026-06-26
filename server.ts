/**
 * @file MCP server: Playwright browser tools + a live UI resource.
 *
 * Model-facing tools (navigate/click/type/...) carry `_meta.ui.resourceUri`, so
 * the first time the model (or the user, via the panel) calls one, the host
 * renders the live browser view. The view then polls the app-only
 * `browser_screenshot` tool (~1/sec) to stream the page as it changes, and
 * forwards the user's clicks and keystrokes back through the same tools.
 */
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { browserManager, type PageInfo } from "./browser.js";

// Works both from source (server.ts via tsx) and a compiled dist/server.js.
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

const RESOURCE_URI = "ui://playwright/mcp-app.html";

// Shared output shape for the page-state tools.
const pageInfoShape = {
  url: z.string(),
  title: z.string(),
};

function pageResult(action: string, p: PageInfo): CallToolResult {
  const where = p.title ? `"${p.title}" (${p.url})` : p.url;
  return {
    content: [{ type: "text", text: `${action} Now at ${where}.` }],
    structuredContent: { url: p.url, title: p.title },
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "Playwright Browser",
    version: "0.1.0",
  });

  const ui = { ui: { resourceUri: RESOURCE_URI } };

  registerAppTool(
    server,
    "browser_navigate",
    {
      title: "Open a web page",
      description:
        "Open a URL in the live browser and show it in the panel. Accepts bare hosts (example.com) or full URLs.",
      inputSchema: { url: z.string().describe("URL or host to open, e.g. https://news.ycombinator.com") },
      outputSchema: pageInfoShape,
      _meta: ui,
    },
    async ({ url }): Promise<CallToolResult> => {
      try {
        return pageResult(`Opened ${url}.`, await browserManager.navigate(url));
      } catch (e) {
        return errorResult(`Failed to open ${url}: ${(e as Error).message}`);
      }
    },
  );

  registerAppTool(
    server,
    "browser_click",
    {
      title: "Click",
      description:
        "Click the page, either by a CSS selector or by viewport pixel coordinates (x, y). The panel uses x/y when you click the live image.",
      inputSchema: {
        selector: z.string().optional().describe("CSS selector to click"),
        x: z.number().optional().describe("Viewport X in pixels (use with y)"),
        y: z.number().optional().describe("Viewport Y in pixels (use with x)"),
      },
      outputSchema: pageInfoShape,
      _meta: ui,
    },
    async ({ selector, x, y }): Promise<CallToolResult> => {
      try {
        if (selector) {
          return pageResult(`Clicked ${selector}.`, await browserManager.clickSelector(selector));
        }
        if (typeof x === "number" && typeof y === "number") {
          return pageResult(`Clicked (${x}, ${y}).`, await browserManager.clickAt(x, y));
        }
        return errorResult("browser_click needs either `selector` or both `x` and `y`.");
      } catch (e) {
        return errorResult(`Click failed: ${(e as Error).message}`);
      }
    },
  );

  registerAppTool(
    server,
    "browser_type",
    {
      title: "Type text",
      description:
        "Type text into the page. With a selector it fills that field; without one it types into whatever is focused. Set submit=true to press Enter afterwards.",
      inputSchema: {
        text: z.string().describe("Text to type"),
        selector: z.string().optional().describe("Optional CSS selector to fill instead of the focused element"),
        submit: z.boolean().optional().describe("Press Enter after typing"),
      },
      outputSchema: pageInfoShape,
      _meta: ui,
    },
    async ({ text, selector, submit }): Promise<CallToolResult> => {
      try {
        const p = await browserManager.type(text, selector, submit ?? false);
        return pageResult(`Typed ${JSON.stringify(text)}${submit ? " + Enter" : ""}.`, p);
      } catch (e) {
        return errorResult(`Type failed: ${(e as Error).message}`);
      }
    },
  );

  registerAppTool(
    server,
    "browser_press",
    {
      title: "Press a key",
      description:
        "Press a single key or chord, e.g. Enter, Tab, Escape, Backspace, ArrowDown, Control+A.",
      inputSchema: { key: z.string().describe("Key name, e.g. Enter, Tab, ArrowDown, Control+A") },
      outputSchema: pageInfoShape,
      _meta: ui,
    },
    async ({ key }): Promise<CallToolResult> => {
      try {
        return pageResult(`Pressed ${key}.`, await browserManager.press(key));
      } catch (e) {
        return errorResult(`Key press failed: ${(e as Error).message}`);
      }
    },
  );

  registerAppTool(
    server,
    "browser_scroll",
    {
      title: "Scroll",
      description: "Scroll the page by a pixel delta. Positive dy scrolls down, negative scrolls up.",
      inputSchema: {
        dx: z.number().optional().describe("Horizontal pixels (default 0)"),
        dy: z.number().optional().describe("Vertical pixels (default 600)"),
      },
      outputSchema: pageInfoShape,
      _meta: ui,
    },
    async ({ dx, dy }): Promise<CallToolResult> => {
      try {
        return pageResult("Scrolled.", await browserManager.scroll(dx ?? 0, dy ?? 600));
      } catch (e) {
        return errorResult(`Scroll failed: ${(e as Error).message}`);
      }
    },
  );

  registerAppTool(
    server,
    "browser_back",
    { title: "Go back", description: "Navigate back in history.", inputSchema: {}, outputSchema: pageInfoShape, _meta: ui },
    async (): Promise<CallToolResult> => pageResult("Went back.", await browserManager.back()),
  );

  registerAppTool(
    server,
    "browser_forward",
    { title: "Go forward", description: "Navigate forward in history.", inputSchema: {}, outputSchema: pageInfoShape, _meta: ui },
    async (): Promise<CallToolResult> => pageResult("Went forward.", await browserManager.forward()),
  );

  registerAppTool(
    server,
    "browser_reload",
    { title: "Reload", description: "Reload the current page.", inputSchema: {}, outputSchema: pageInfoShape, _meta: ui },
    async (): Promise<CallToolResult> => pageResult("Reloaded.", await browserManager.reload()),
  );

  registerAppTool(
    server,
    "browser_read_page",
    {
      title: "Read page text",
      description: "Return the visible text of the current page so you can read and reason about its content.",
      inputSchema: {},
      outputSchema: { ...pageInfoShape, text: z.string() },
      _meta: ui,
    },
    async (): Promise<CallToolResult> => {
      const { url, title, text } = await browserManager.readText();
      return {
        content: [{ type: "text", text: text || "(no visible text)" }],
        structuredContent: { url, title, text },
      };
    },
  );

  // App-only: the panel polls this for the live view. Hidden from the model to
  // avoid flooding its context with base64 image data.
  registerAppTool(
    server,
    "browser_screenshot",
    {
      title: "Capture viewport",
      description: "Returns a JPEG data URL of the current viewport plus its pixel size. App-only.",
      inputSchema: {},
      outputSchema: {
        image: z.string(),
        width: z.number(),
        height: z.number(),
        ...pageInfoShape,
      },
      _meta: { ui: { visibility: ["app"] } },
    },
    async (): Promise<CallToolResult> => {
      const shot = await browserManager.screenshot();
      return {
        content: [{ type: "text", text: `Captured ${shot.url}` }],
        structuredContent: {
          image: shot.image,
          width: shot.width,
          height: shot.height,
          url: shot.url,
          title: shot.title,
        },
      };
    },
  );

  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE, description: "Live Playwright browser view" },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
      return {
        contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
