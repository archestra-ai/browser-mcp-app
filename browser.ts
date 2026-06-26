/**
 * @file Singleton Playwright browser manager.
 *
 * The HTTP transport creates a fresh `McpServer` per request, so the browser
 * itself must live at module scope and be shared across every server instance
 * (and the single stdio instance). All actions run through a tiny promise-chain
 * lock so concurrent tool calls (e.g. the model navigating while the UI polls a
 * screenshot) never collide on the same page.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const HEADLESS = /^(1|true|yes|on)$/i.test(process.env.HEADLESS ?? "");
const VIEWPORT = { width: 1280, height: 800 };
const JPEG_QUALITY = Number(process.env.SCREENSHOT_QUALITY ?? "60");

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

// Serialize every browser action. `then(fn, fn)` runs the next action after the
// previous one settles regardless of outcome; the trailing swallow keeps one
// failure from poisoning the chain.
let queue: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function ensurePage(): Promise<Page> {
  if (!browser) {
    browser = await chromium.launch({ headless: HEADLESS });
  }
  if (!context) {
    context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    context.setDefaultTimeout(15_000);
    context.setDefaultNavigationTimeout(30_000);
  }
  if (!page || page.isClosed()) {
    page = await context.newPage();
    await page.goto("about:blank").catch(() => {});
  }
  return page;
}

export interface PageInfo {
  url: string;
  title: string;
}

export interface Shot extends PageInfo {
  /** A `data:image/jpeg;base64,...` URL of the current viewport. */
  image: string;
  /** Viewport pixel dimensions — used by the UI to map clicks back to the page. */
  width: number;
  height: number;
}

async function info(p: Page): Promise<PageInfo> {
  let title = "";
  try {
    title = await p.title();
  } catch {
    /* title can throw mid-navigation; ignore */
  }
  return { url: p.url(), title };
}

/** Add an https:// scheme to bare hosts like "example.com". */
function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) || trimmed.startsWith("about:")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export const browserManager = {
  viewport: VIEWPORT,
  headless: HEADLESS,

  navigate(url: string): Promise<PageInfo> {
    return withLock(async () => {
      const p = await ensurePage();
      await p.goto(normalizeUrl(url), { waitUntil: "domcontentloaded" });
      return info(p);
    });
  },

  clickSelector(selector: string): Promise<PageInfo> {
    return withLock(async () => {
      const p = await ensurePage();
      await p.click(selector);
      return info(p);
    });
  },

  clickAt(x: number, y: number): Promise<PageInfo> {
    return withLock(async () => {
      const p = await ensurePage();
      await p.mouse.click(x, y);
      return info(p);
    });
  },

  type(text: string, selector: string | undefined, submit: boolean): Promise<PageInfo> {
    return withLock(async () => {
      const p = await ensurePage();
      if (selector) {
        await p.fill(selector, text);
      } else {
        await p.keyboard.type(text, { delay: 15 });
      }
      if (submit) await p.keyboard.press("Enter");
      return info(p);
    });
  },

  press(key: string): Promise<PageInfo> {
    return withLock(async () => {
      const p = await ensurePage();
      await p.keyboard.press(key);
      return info(p);
    });
  },

  scroll(dx: number, dy: number): Promise<PageInfo> {
    return withLock(async () => {
      const p = await ensurePage();
      await p.mouse.wheel(dx, dy);
      return info(p);
    });
  },

  back(): Promise<PageInfo> {
    return withLock(async () => {
      const p = await ensurePage();
      await p.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      return info(p);
    });
  },

  forward(): Promise<PageInfo> {
    return withLock(async () => {
      const p = await ensurePage();
      await p.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
      return info(p);
    });
  },

  reload(): Promise<PageInfo> {
    return withLock(async () => {
      const p = await ensurePage();
      await p.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      return info(p);
    });
  },

  /** Visible text of the page, for the model to read. Truncated to keep tokens sane. */
  readText(): Promise<PageInfo & { text: string }> {
    return withLock(async () => {
      const p = await ensurePage();
      const meta = await info(p);
      const text = await p
        .evaluate(() => document.body?.innerText ?? "")
        .catch(() => "");
      return { ...meta, text: text.slice(0, 8000) };
    });
  },

  screenshot(): Promise<Shot> {
    return withLock(async () => {
      const p = await ensurePage();
      const buf = await p.screenshot({ type: "jpeg", quality: JPEG_QUALITY });
      const meta = await info(p);
      return {
        image: `data:image/jpeg;base64,${buf.toString("base64")}`,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        ...meta,
      };
    });
  },

  async close(): Promise<void> {
    try {
      await context?.close();
    } catch {
      /* ignore */
    }
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    context = null;
    browser = null;
    page = null;
  },
};
