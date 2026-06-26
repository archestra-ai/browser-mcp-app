# Browser MCP App

An MCP App that drives a real Chromium browser with Playwright and renders a live,
clickable view of the page inside an MCP host such as [Archestra]. The agent can browse
for you, and you can take over in the panel — click, type, scroll, navigate.

## How it works

Browser tools (`browser_navigate`, `browser_click`, `browser_type`, `browser_press`,
`browser_scroll`, `browser_back`/`forward`/`reload`, `browser_read_page`) drive one
shared Playwright page. The UI panel polls an app-only `browser_screenshot` tool (~1/s),
maps your clicks back to viewport pixels, and forwards your keystrokes — so the model
and you drive the same page.

## Setup

```bash
npm install
npm run browsers   # one-time: download Chromium
npm run build      # bundle the UI into dist/mcp-app.html
```

## Run

```bash
npm run serve         # HTTP transport on :3001  (npm run dev = watch mode)
npm run serve:stdio   # stdio transport
```

To use it from an MCP host (e.g. Archestra), build first and point the host's MCP config
at the stdio entry:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "tsx", "/absolute/path/to/browser-mcp-app/main.ts", "--stdio"]
    }
  }
}
```

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `HEADLESS` | unset → headed | `1`/`true` runs Chromium headless. |
| `PORT` | `3001` | HTTP port. |
| `SCREENSHOT_QUALITY` | `60` | JPEG quality for the live view. |

## Development

Built with the **`create-mcp-app`** Agent Skill, which covers the MCP Apps SDK patterns
used here (tool + UI-resource registration, app lifecycle, host context, polling). Use
it when extending the server — invoke `/create-mcp-app`.

## Notes

- One shared browser page; actions are serialized so calls don't race.
- The live view is a screenshot stream — page pixels never go to the model; only
  `browser_read_page` returns text, on request.
- It's a real browser: it can log in and submit forms. Don't point it at sites where an
  unintended click would be costly.

[Archestra]: https://archestra.ai
[Playwright]: https://playwright.dev
