import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = ReactDOM.createRoot(document.getElementById("root")!);

// 本地入口只在开发模式中加载。
const params = new URLSearchParams(window.location.search);

if (import.meta.env.DEV && params.get("live") === "openai-api") {
  void import("./preview/openai-api-live").then(({ OpenAiApiLive }) => {
    root.render(<OpenAiApiLive />);
  });
} else if (import.meta.env.DEV && params.get("preview") === "openai-api") {
  void import("./preview/openai-api").then(({ OpenAiApiPreview }) => {
    root.render(<OpenAiApiPreview />);
  });
} else {
  root.render(<App />);
}
