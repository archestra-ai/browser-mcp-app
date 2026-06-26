/**
 * @file Live browser panel.
 *
 * Polls the app-only `browser_screenshot` tool to stream the page as a JPEG,
 * maps clicks on that image back to viewport pixels, and forwards keystrokes —
 * all by calling the server's browser tools via `app.callServerTool`. When the
 * model drives the browser, `ontoolresult` refreshes the view immediately.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import "./global.css";
import "./mcp-app.css";

interface Shot {
  image: string;
  width: number;
  height: number;
  url: string;
  title: string;
}

const POLL_MS = 900;

// ---- DOM ---------------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const appEl = document.querySelector(".app") as HTMLElement;
const viewport = $("viewport");
const screen = $<HTMLImageElement>("screen");
const placeholder = $("placeholder");
const urlInput = $<HTMLInputElement>("url");
const addressForm = $<HTMLFormElement>("address");
const typeForm = $<HTMLFormElement>("type-form");
const typeText = $<HTMLInputElement>("type-text");
const submitChk = $<HTMLInputElement>("submit");
const dot = $("dot");
const statusText = $("status-text");
const liveToggle = $<HTMLButtonElement>("live-toggle");

// Natural (viewport) pixel size of the current screenshot. Updated each poll.
let natW = 1280;
let natH = 800;

// ---- App ---------------------------------------------------------------------
const app = new App({ name: "Live Browser", version: "0.1.0" });

let inFlight = false;
let timer: number | null = null;
let live = false;

function setStatus(kind: "live" | "paused" | "busy" | "error", text: string): void {
  dot.className = `dot ${kind}`;
  statusText.textContent = text;
}

function applyShot(s: Shot): void {
  natW = s.width || natW;
  natH = s.height || natH;
  screen.src = s.image;
  placeholder.style.display = "none";
  if (document.activeElement !== urlInput && s.url && s.url !== "about:blank") {
    urlInput.value = s.url;
  }
}

async function refreshNow(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await app.callServerTool({ name: "browser_screenshot", arguments: {} });
    const s = res.structuredContent as unknown as Shot | undefined;
    if (s?.image) applyShot(s);
    if (live) setStatus("live", "Live");
  } catch (e) {
    console.error("screenshot failed", e);
    setStatus("error", "Reconnecting…");
  } finally {
    inFlight = false;
  }
}

/** Call a browser tool for a user action, then immediately refresh the view. */
async function drive(name: string, args: Record<string, unknown>): Promise<void> {
  setStatus("busy", "Working…");
  try {
    await app.callServerTool({ name, arguments: args });
  } catch (e) {
    console.error(name, "failed", e);
  } finally {
    void refreshNow();
  }
}

function startLive(): void {
  if (timer != null) return;
  live = true;
  liveToggle.textContent = "‖";
  liveToggle.title = "Pause live view";
  void refreshNow();
  timer = window.setInterval(refreshNow, POLL_MS);
}

function stopLive(): void {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
  live = false;
  liveToggle.textContent = "▶";
  liveToggle.title = "Resume live view";
  setStatus("paused", "Paused");
}

// ---- Interactions ------------------------------------------------------------

// Click on the live image → click the page at the mapped viewport coordinate.
screen.addEventListener("click", (e) => {
  const rect = screen.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = Math.round(((e.clientX - rect.left) / rect.width) * natW);
  const y = Math.round(((e.clientY - rect.top) / rect.height) * natH);
  viewport.focus();
  void drive("browser_click", { x, y });
});

// Scroll over the live image → scroll the page.
viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    void drive("browser_scroll", { dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
  },
  { passive: false },
);

// Typing while the live view is focused goes straight to the page.
const SPECIAL = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

viewport.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return; // let host/browser shortcuts through
  if (SPECIAL.has(e.key)) {
    e.preventDefault();
    void drive("browser_press", { key: e.key });
  } else if (e.key.length === 1) {
    e.preventDefault();
    void drive("browser_type", { text: e.key });
  }
});

// Address bar.
addressForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const u = urlInput.value.trim();
  if (u) void drive("browser_navigate", { url: u });
});

// Explicit "type a whole string" box (handy for longer input).
typeForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const t = typeText.value;
  if (!t) return;
  void drive("browser_type", { text: t, submit: submitChk.checked });
  typeText.value = "";
});

$("back").addEventListener("click", () => void drive("browser_back", {}));
$("forward").addEventListener("click", () => void drive("browser_forward", {}));
$("reload").addEventListener("click", () => void drive("browser_reload", {}));

liveToggle.addEventListener("click", () => (live ? stopLive() : startLive()));

$("fullscreen").addEventListener("click", async () => {
  const ctx = app.getHostContext();
  const current = ctx?.displayMode ?? "inline";
  const next = current === "inline" ? "fullscreen" : "inline";
  if (ctx?.availableDisplayModes?.includes(next)) {
    try {
      await app.requestDisplayMode({ mode: next });
    } catch (e) {
      console.error("display mode change failed", e);
    }
  }
});

// Pause polling when the panel is hidden; resume when visible again.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
  } else if (live) {
    startLive();
  }
});

// ---- Host context (theme / fonts / safe area) --------------------------------
function handleHostContextChanged(ctx: McpUiHostContext): void {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    appEl.style.paddingTop = `${ctx.safeAreaInsets.top}px`;
    appEl.style.paddingRight = `${ctx.safeAreaInsets.right}px`;
    appEl.style.paddingBottom = `${ctx.safeAreaInsets.bottom}px`;
    appEl.style.paddingLeft = `${ctx.safeAreaInsets.left}px`;
  }
}

app.onerror = console.error;
app.onhostcontextchanged = handleHostContextChanged;

// When the model drives the browser, refresh straight away.
app.ontoolresult = (result) => {
  const sc = result.structuredContent as { url?: string } | undefined;
  if (sc?.url && document.activeElement !== urlInput && sc.url !== "about:blank") {
    urlInput.value = sc.url;
  }
  void refreshNow();
};

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) handleHostContextChanged(ctx);
  setStatus("busy", "Starting…");
  startLive();
});
