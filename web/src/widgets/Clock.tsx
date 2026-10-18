import { useState } from "react";
import type { WidgetProps } from "./types";
import { Title, useTick } from "./common";
import { hour12Of, useSettings } from "../settings";

export function Clock({ tile }: WidgetProps) {
  const { settings } = useSettings();
  const [now, setNow] = useState(() => new Date());
  useTick(1000, () => setNow(new Date()));
  // A tile can force 24-hour time; otherwise the dashboard's time zone and clock format apply.
  const hour12 = tile.config.hour24 === true ? false : hour12Of(settings);
  const timeZone = typeof tile.config.timezone === "string" && tile.config.timezone ? tile.config.timezone : settings.timezone;
  return (
    <>
      <Title right={tile.config.label ? String(tile.config.label) : undefined}>{now.toLocaleDateString([], { weekday: "long", timeZone })}</Title>
      <div className="clock-time">{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12, timeZone })}</div>
      <div className="sub">{now.toLocaleDateString([], { month: "long", day: "numeric", year: "numeric", timeZone })}</div>
    </>
  );
}
