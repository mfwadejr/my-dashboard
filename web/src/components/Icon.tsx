import { useState } from "react";
import { iconUrl } from "../api";

const letters = (name: string) => name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase() || "?";

/** A saved icon, or the first letters of the name when there is none (or the file cannot be loaded). Lucide icons are drawn light for dark themes and inverted on the light theme. */
export function Icon({ icon, iconRef, name = "", size = 20, className = "" }: { icon?: string | null; iconRef?: string | null; name?: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!icon || failed === icon) return <span className={`ico-fallback ${className}`} style={{ width: size, height: size, fontSize: Math.max(9, size * 0.42) }} aria-hidden="true">{letters(name)}</span>;
  return <img className={`ico ${iconRef?.startsWith("lucide:") ? "ic-lucide" : ""} ${className}`} src={iconUrl(icon)} width={size} height={size} alt="" draggable={false} onError={() => setFailed(icon)} />;
}
