import { createRoot } from "react-dom/client";
import { html } from "./html.js?v=11";
import { App } from "./App.js?v=11";

const root = createRoot(document.getElementById("root"));
root.render(html`<${App} />`);
