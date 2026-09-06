import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Portal from "../app/portal";
import "../app/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Elemento raiz do SICC não encontrado.");

createRoot(root).render(
  <StrictMode>
    <Portal />
  </StrictMode>,
);
