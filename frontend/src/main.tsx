import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { isDemoMode, isPublicMode } from "./demo/mode";

async function bootstrap() {
  if (isPublicMode) {
    await import("./public/install");
  } else if (isDemoMode) {
    await import("./demo/install");
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
