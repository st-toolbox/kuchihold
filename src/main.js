import { createRoot } from "react-dom/client";
import { html } from "./html.js?v=20";
import { App } from "./App.js?v=20";

const root = createRoot(document.getElementById("root"));
root.render(html`<${App} />`);
