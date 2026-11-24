import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { captureInstallPrompt } from "./net/install";
import { registerServiceWorker } from "./net/turnAlerts";
import "./index.css";

// iOS Safari ignores user-scalable=no and touch-action for pinches; its own gesture events
// are the only way to stop a pinch zooming the page.
for (const type of ["gesturestart", "gesturechange"]) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

// Before React: Chrome fires its install prompt early, and only once.
captureInstallPrompt();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker only handles turn alerts (public/sw.js caches nothing), so it can wait
// until the page has loaded. Registering it on every visit also keeps the app installable.
if (document.readyState === "complete") void registerServiceWorker();
else window.addEventListener("load", () => void registerServiceWorker(), { once: true });
