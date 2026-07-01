import { createRoot } from "react-dom/client";
import { html } from "./html.js?v=22";
import { App } from "./App.js?v=22";

const root = createRoot(document.getElementById("root"));
root.render(html`<${App} />`);
// ブート監視（index.html 側）に「起動できた」ことを知らせる。
window.__appBooted = true;
