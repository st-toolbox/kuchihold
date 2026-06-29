// htm を React の createElement にバインドして、ビルド無しで JSX 風の記述を可能にする。
import React from "react";
import htm from "htm";

export const html = htm.bind(React.createElement);
export { React };
