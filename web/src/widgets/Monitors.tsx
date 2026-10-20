import { useMonitors } from "../hooks";
import { StateDot, Strip, childCounts, fmtMs, fmtPct, groupState, groupTree } from "../components/MonitorBits";
import type { WidgetProps } from "./types";
import { Empty, Pill, Title } from "./common";

export function Monitors({ tile }: WidgetProps) {
  const { items, loaded } = useMonitors();
  const chosen = (tile.config.monitorIds ?? []) as string[];
  const rows = chosen.length ? chosen.map(id => items.find(m => m.id === id)).filter((m): m is NonNullable<typeof m> => Boolean(m)) : items;
  const live = rows.filter(m => m.state !== "paused" && m.state !== "unknown" && m.state !== "maintenance");
  const down = live.filter(m => m.state === "down").length;
  const title = String(tile.config.title || "Monitors");
  return (
    <>
      <Title right={rows.length ? (live.length ? <Pill tone={down ? "bad" : "ok"}>{down ? `${down} down` : "all up"}</Pill> : <Pill tone="mute">waiting</Pill>) : undefined}>{title}</Title>
      {!loaded ? <Empty>Loading…</Empty> : !rows.length ? <Empty>No monitors yet. Add them on the Monitoring tab.</Empty> : (
        <div className="list">
          {groupTree(rows).map(g => (
            <div key={g.name || "_"} className="mtile-group">
              {g.name && <div className="li mghead-sm"><StateDot state={groupState(g.rows.map(r => r.item))} /><b className="trunc f1">{g.name}</b><span className="sub">{g.rows.filter(r => r.item.state === "up").length}/{g.rows.length}</span></div>}
              {g.rows.map(({ item: m, depth }) => (
                <div key={m.id} className={`li mrow${g.name || depth ? " indent" : ""}${depth > 1 ? " deeper" : ""}`} title={m.message}>
                  <StateDot state={m.state} />
                  <span className="trunc f1">{m.kind === "group" ? <b>{m.name}</b> : m.name}</span>
                  <Strip checks={m.strip} count={16} />
                  <span className="sub mnum">{m.state === "down" ? "down" : m.state === "maintenance" ? "maint." : m.kind === "group" ? `${childCounts(rows, m.id).up}/${childCounts(rows, m.id).total}` : fmtMs(m.lastMs)}</span>
                  <span className="sub mnum">{fmtPct(m.uptime24h)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
