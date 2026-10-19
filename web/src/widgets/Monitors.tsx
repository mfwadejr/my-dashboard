import { useMonitors } from "../hooks";
import { StateDot, Strip, fmtMs, fmtPct } from "../components/MonitorBits";
import type { WidgetProps } from "./types";
import { Empty, Pill, Title } from "./common";

export function Monitors({ tile }: WidgetProps) {
  const { items, loaded } = useMonitors();
  const chosen = (tile.config.monitorIds ?? []) as string[];
  const rows = chosen.length ? chosen.map(id => items.find(m => m.id === id)).filter((m): m is NonNullable<typeof m> => Boolean(m)) : items;
  const live = rows.filter(m => m.state !== "paused" && m.state !== "unknown");
  const down = live.filter(m => m.state === "down").length;
  const title = String(tile.config.title || "Monitors");
  return (
    <>
      <Title right={rows.length ? (live.length ? <Pill tone={down ? "bad" : "ok"}>{down ? `${down} down` : "all up"}</Pill> : <Pill tone="mute">waiting</Pill>) : undefined}>{title}</Title>
      {!loaded ? <Empty>Loading…</Empty> : !rows.length ? <Empty>No monitors yet. Add them in Settings → Monitors.</Empty> : (
        <div className="list">
          {rows.map(m => (
            <div key={m.id} className="li mrow" title={m.message}>
              <StateDot state={m.state} />
              <span className="trunc f1">{m.name}</span>
              <Strip checks={m.strip} count={16} />
              <span className="sub mnum">{m.state === "down" ? "down" : fmtMs(m.lastMs)}</span>
              <span className="sub mnum">{fmtPct(m.uptime24h)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
