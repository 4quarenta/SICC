import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Portal from "../app/portal";
import "../app/globals.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // Version the registration URL and bypass the browser HTTP cache so a
    // previous Pages bundle cannot remain active after a deployment.
    void navigator.serviceWorker.register("./sw.js?v=3", { updateViaCache: "none" }).catch(() => {
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
