import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* basename = Vite's base (import.meta.env.BASE_URL): "/" on a custom domain,
        "/agent-connector/" on a GitHub Pages project site — keeps client routes
        and <Link>s correct under whichever path the app is served from. */}
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
