/** A three-quarter arc gauge in the style of ZimaOS's own System widget: big number inside, label under it, a detail line below. */
const polar = (r: number, deg: number): [number, number] => { const a = ((deg - 90) * Math.PI) / 180; return [60 + r * Math.cos(a), 60 + r * Math.sin(a)]; };
const arc = (r: number, a0: number, a1: number) => { const [x0, y0] = polar(r, a0), [x1, y1] = polar(r, a1); return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`; };

export function Gauge({ pct, label, detail, warn = 70, bad = 90, hot }: { pct: number | null | undefined; label: string; detail?: string; warn?: number; bad?: number; hot?: boolean }) {
  const v = typeof pct === "number" && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
  const color = v === null ? "var(--mute)" : v >= bad ? "var(--bad)" : v >= warn ? "var(--warn)" : "var(--ok)";
  const start = -135, end = 135;
  return (
    <div className="gauge">
      <svg viewBox="8 6 104 96" role="img" aria-label={`${label} ${v === null ? "unavailable" : Math.round(v) + "%"}`}>
        <path d={arc(46, start, end)} fill="none" stroke="var(--panel2)" strokeWidth="11" strokeLinecap="round" />
        {v !== null && v > 0.5 && <path d={arc(46, start, start + (end - start) * (v / 100))} fill="none" stroke={color} strokeWidth="11" strokeLinecap="round" />}
        <text x="60" y="63" textAnchor="middle" className="gv">{v === null ? "–" : Math.round(v)}{v !== null && <tspan className="gu" dx="1">%</tspan>}</text>
        <text x="60" y="94" textAnchor="middle" className="gl">{label}</text>
      </svg>
      {detail && <div className={`gd ${hot ? "warn" : ""}`}>{detail}</div>}
    </div>
  );
}
