import { createRoot } from "react-dom/client";
import { html } from "./html.js?v=21";
import { App } from "./App.js?v=21";

const root = createRoot(document.getElementById("root"));
root.render(html`<${App} />`);
