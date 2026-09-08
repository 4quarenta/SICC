import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Portal from "../app/portal";
import "../app/globals.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js").catch(() => {
      // A instalação opcional não deve impedir o uso normal do sistema.
    });
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("Elemento raiz do SICC não encontrado.");

createRoot(root).render(
  <StrictMode>
    <Portal />
  </StrictMode>,
);
