import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import App from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { registerServiceWorker } from "./utils/register-service-worker.js";
import "./index.css";

registerServiceWorker();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          <Route path="/session/:sessionId" element={<App />} />
          <Route path="*" element={<App />} />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>
);
