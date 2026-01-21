import { createRoot } from "react-dom/client";
import "./style.css";
import { App } from "./App";

const root = document.getElementById("app");
if (root) {
  createRoot(root).render(<App />);
}
