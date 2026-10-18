import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { OpenerProvider } from "./components/Opener";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<StrictMode><OpenerProvider><App /></OpenerProvider></StrictMode>);
