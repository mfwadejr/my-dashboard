import { useState } from "react";
import type { WidgetProps } from "./types";
import { Title, useTick } from "./common";

export function Clock({ tile }: WidgetProps) {
  const [now, setNow] = useState(() => new Date());
  useTick(1000, () => setNow(new Date()));
  const h24 = tile.config.hour24 === true;
  return (
    <>
      <Title right={tile.config.label ? String(tile.config.label) : undefined}>{now.toLocaleDateString([], { weekday: "long" })}</Title>
      <div className="clock-time">{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: !h24 })}</div>
      <div className="sub">{now.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" })}</div>
    </>
  );
}
