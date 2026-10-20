import { useRef, useState, type ReactNode, type RefObject } from "react";
import { iconUrl } from "../api";
import type { RackDeviceInfo, RackInfo } from "../types";
import { clashes, kindInfo, onFace, rangeText, unitLabel, type Live } from "./model";

export const IN = 22, POST = 30, UH = 24, HEAD = 34, FOOT = 12;
const trim = (s: string, px: number) => { const max = Math.max(3, Math.floor(px / 6.4)); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

/** Rows of small marks (ports, outlets) packed into the space from x0 to x1, vertically centred in a plate of height h. */
function grid(count: number, x0: number, x1: number, h: number, shape: "sq" | "round", key: string): ReactNode {
  if (count <= 0 || x1 - x0 < 20) return null;
  // A standard 1U panel or switch has up to 24 ports in one row; 48 go in two. Rows are added only when a row would not fit or the plate is tall.
  const room = Math.max(1, Math.floor((h - 4) / 9)), rows = Math.min(room, Math.max(Math.ceil(count / 24), Math.ceil(count / Math.max(1, Math.floor((x1 - x0) / 7))))), cols = Math.ceil(count / rows), pitch = Math.min(15, (x1 - x0) / cols), size = Math.max(4, Math.min(10, pitch * 0.7));
  const rowH = size + 3, top = (h - rows * rowH + 3) / 2, start = x1 - cols * pitch;
  const out: ReactNode[] = [];
  for (let i = 0; i < count; i++) {
    const r = i % rows, c = Math.floor(i / rows), x = start + c * pitch + (pitch - size) / 2, y = top + r * rowH;
    out.push(shape === "sq" ? <rect key={i} className="rk-port" x={x} y={y} width={size} height={size} rx={1} /> : <circle key={i} className="rk-port" cx={x + size / 2} cy={y + size / 2} r={size / 2} />);
  }
  return <g key={key}>{out}</g>;
}

function bays(count: number, x0: number, x1: number, h: number, tall: boolean): ReactNode {
  if (count <= 0 || x1 - x0 < 30) return null;
  const rows = tall || count <= 4 ? 1 : 2, cols = Math.ceil(count / rows), bw = Math.min(46, (x1 - x0) / cols - 3), bh = (h - 10) / rows - 2;
  const out: ReactNode[] = [];
  for (let i = 0; i < count; i++) { const r = Math.floor(i / cols), c = i % cols; out.push(<rect key={i} className="rk-bay" x={x1 - (cols - c) * (bw + 3)} y={5 + r * (bh + 2)} width={bw} height={bh} rx={1.5} />); }
  return <g>{out}</g>;
}

function Plate({ d, w, h, view, live }: { d: RackDeviceInfo; w: number; h: number; view: "front" | "rear"; live: Live }) {
  const dot = live.state !== "none";
  const nameX = dot ? 20 : 12;
  const label = live.watts !== null ? `${d.name} · ${live.watts} W` : d.name;
  const split = d.kind === "blank" || d.kind === "cable" || d.kind === "shelf" ? w - 24 : Math.max(60, w * 0.4);
  const art: ReactNode[] = [];
  const inner0 = split + 8, inner1 = w - 12;
  if (view === "front") {
    if (d.kind === "switch" || d.kind === "router") art.push(grid(d.ports || kindInfo(d.kind).ports, inner0, inner1, h, "sq", "p"));
    else if (d.kind === "patch") art.push(grid(d.ports || 24, inner0, inner1, h, "sq", "p"));
    else if (d.kind === "pdu") art.push(grid(d.ports || 8, inner0, inner1, h, "round", "p"));
    else if (d.kind === "server") { art.push(bays(d.ports || 8, inner0 + 14, inner1, h, false)); art.push(<circle key="pw" className="rk-led" cx={inner0 + 4} cy={h / 2} r={3} />); }
    else if (d.kind === "nas") art.push(bays(d.ports || 4, inner0, inner1, h, true));
    else if (d.kind === "ups") {
      art.push(<rect key="lcd" className="rk-lcd" x={inner0} y={h * 0.25} width={Math.min(70, inner1 - inner0 - 70)} height={h * 0.5} rx={2} />);
      for (let i = 0; i < 4; i++) art.push(<rect key={`b${i}`} className="rk-port" x={inner1 - 60 + i * 15} y={h * 0.3} width={10} height={h * 0.4} rx={1} />);
    } else if (d.kind === "cable") for (let x = 14; x < w - 14; x += 6) art.push(<line key={x} className="rk-brush" x1={x} y1={4} x2={x} y2={h - 4} />);
    else if (d.kind === "generic") for (let i = 0; i < Math.min(6, Math.floor((h - 6) / 4)); i++) art.push(<line key={i} className="rk-brush" x1={inner0} y1={5 + i * 4} x2={inner1} y2={5 + i * 4} />);
  } else {
    // The back: power supplies and sockets, which is what you look for when cabling.
    if (d.kind === "patch") art.push(grid(d.ports || 24, inner0, inner1, h, "sq", "p"));
    else if (d.kind === "pdu") art.push(grid(d.ports || 8, inner0, inner1, h, "round", "p"));
    else if (["switch", "router", "server", "nas", "ups"].includes(d.kind)) {
      const n = d.kind === "server" || d.kind === "nas" ? 2 : 1;
      for (let i = 0; i < n; i++) art.push(<rect key={`psu${i}`} className="rk-psu" x={inner1 - 46 - i * 52} y={4} width={46} height={h - 8} rx={2} />);
      if (d.kind === "switch" || d.kind === "router") art.push(grid(2, inner0, inner1 - 60, h, "sq", "uplink"));
    }
  }
  const shelf = d.kind === "shelf";
  return (
    <>
      <rect className={`rk-body ${d.kind === "blank" ? "blank" : ""} ${shelf ? "shelf" : ""}`} width={w} height={h} rx={2} />
      {d.color && <rect className={`rk-stripe c${d.color}`} width={4} height={h} />}
      {dot && <circle className={`rk-dot ${live.state}`} cx={12} cy={h / 2} r={3.5} />}
      {d.kind !== "blank" || h > 30 ? <text className={`rk-name ${d.kind === "blank" ? "faint" : ""}`} x={nameX} y={h / 2} dominantBaseline="central">{trim(label, split - nameX)}</text> : null}
      {art}
      {h >= 20 && <><circle className="rk-screw" cx={w - 5} cy={5} r={1.6} /><circle className="rk-screw" cx={w - 5} cy={h - 5} r={1.6} /></>}
    </>
  );
}

interface Drag { id: string; startY: number; startSlot: number; moved: boolean; slot: number; ok: boolean }

/** The rack drawn to scale. Administrators drag devices to move them and click an empty unit to add one there. */
export function RackSvg({ rack, view, live, selectedId, onSelect, admin, onMove, onAddAt, svgRef }: {
  rack: RackInfo; view: "front" | "rear"; live: (d: RackDeviceInfo) => Live; selectedId: string | null; onSelect: (id: string | null) => void; admin: boolean;
  onMove: (d: RackDeviceInfo, slot: number) => void; onAddAt: (typedU: number) => void; svgRef: RefObject<SVGSVGElement | null>;
}) {
  const inner = rack.width * IN, W = inner + POST * 2, H = HEAD + rack.units * UH + FOOT;
  const yOf = (slot: number, units: number) => HEAD + (rack.units - (slot + units - 1)) * UH;
  const [drag, setDrag] = useState<Drag | null>(null);
  const devs = rack.devices;
  const solid = devs.filter(d => onFace(d, view)), ghost = devs.filter(d => !onFace(d, view));
  // A half-depth device on the other side only shows where nothing on this side covers it.
  const ghosts = ghost.filter(g => !solid.some(s => clashes({ slot: g.slot, units: g.units, face: view }, { slot: s.slot, units: s.units, face: view })));

  // Listeners go on the window the moment the pointer goes down, so a quick drag is never missed while the page re-draws.
  const latest = useRef({ devs, rack, W, onMove, onSelect });
  latest.current = { devs, rack, W, onMove, onSelect };
  const startDrag = (e: React.PointerEvent, d: RackDeviceInfo) => {
    const startY = e.clientY;
    let state: Drag = { id: d.id, startY, startSlot: d.slot, moved: false, slot: d.slot, ok: true };
    setDrag(state);
    const move = (ev: PointerEvent) => {
      const { devs: ds, rack: rk, W: w } = latest.current, svg = svgRef.current;
      if (!svg) return;
      const scale = svg.getBoundingClientRect().width / w, dy = ev.clientY - startY;
      const rows = Math.round(dy / (UH * scale));
      const slot = Math.max(1, Math.min(rk.units - d.units + 1, d.slot - rows));
      state = { ...state, moved: state.moved || Math.abs(dy) > 4, slot, ok: !ds.some(o => o.id !== d.id && clashes({ slot, units: d.units, face: d.face }, o)) };
      setDrag(state);
    };
    const end = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
      setDrag(null);
      if (!state.moved) latest.current.onSelect(d.id);
      else if (state.slot !== d.slot && state.ok) latest.current.onMove(d, state.slot);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end); window.addEventListener("pointercancel", end);
  };

  const taken = new Set<number>();
  for (const d of solid) for (let u = d.slot; u < d.slot + d.units; u++) taken.add(u);

  const place = (d: RackDeviceInfo, ghostly: boolean) => {
    const dragging = drag?.id === d.id && drag.moved;
    const slot = dragging ? drag!.slot : d.slot;
    const width = Math.min(d.width, rack.width) * IN - 2, x = POST + (inner - width) / 2, h = d.units * UH - 2, y = yOf(slot, d.units) + 1;
    const tooWide = d.width > rack.width;
    const l = live(d);
    const pic = view === "front" ? d.icon : d.rearIcon, picture = !ghostly && d.look === "image" && pic;
    return (
      <g key={d.id} transform={`translate(${x} ${y})`} data-device={d.id}
        className={`rk-dev ${ghostly ? "ghost" : ""} ${selectedId === d.id ? "sel" : ""} ${dragging ? (drag!.ok ? "drag ok" : "drag bad") : ""} ${admin && !ghostly ? "mv" : ""}`}
        onPointerDown={e => { if (ghostly) { onSelect(d.id); return; } if (admin && e.button === 0) { e.preventDefault(); startDrag(e, d); } else onSelect(d.id); }}
        onClick={ev => { ev.stopPropagation(); if (!admin) onSelect(d.id); }}>
        <title>{`${d.name} · ${rangeText(rack, d)}${tooWide ? " · wider than this rack" : ""}`}</title>
        {picture ? <>
          <svg width={width} height={h} overflow="hidden"><rect width={width} height={h} className="rk-picbg" />
            <image href={iconUrl(pic)} width={width} height={h} preserveAspectRatio={d.fit === "fit" ? "xMidYMid meet" : d.fit === "fill" ? "xMidYMid slice" : "none"} /></svg>
          <rect className="rk-frame" width={width} height={h} rx={2} />
        </> : <Plate d={d} w={width} h={h} view={ghostly ? (view === "front" ? "rear" : "front") : view} live={l} />}
        {tooWide && <rect className="rk-wide" width={width} height={h} rx={2} />}
      </g>
    );
  };

  return (
    <svg ref={svgRef} className="rk-svg" viewBox={`0 0 ${W} ${H}`} width={W} role="img" aria-label={`${rack.name}, ${rack.units}U, ${view} view`} onClick={() => onSelect(null)}>
      <defs>
        <pattern id="rk-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" className="rk-hatchline" /></pattern>
      </defs>
      <rect className="rk-bg" width={W} height={H} rx={8} />
      <text className="rk-title" x={W / 2} y={20} textAnchor="middle">{rack.name} · {view === "front" ? "front" : "rear"}</text>
      <rect className="rk-post" x={POST - 8} y={HEAD - 4} width={8} height={rack.units * UH + 8} />
      <rect className="rk-post" x={POST + inner} y={HEAD - 4} width={8} height={rack.units * UH + 8} />
      <rect className="rk-well" x={POST} y={HEAD} width={inner} height={rack.units * UH} />
      {Array.from({ length: rack.units }, (_, i) => {
        const b = rack.units - i, y = HEAD + i * UH;
        return (
          <g key={b}>
            <line className="rk-line" x1={POST} y1={y} x2={POST + inner} y2={y} />
            <text className="rk-u" x={POST - 12} y={y + UH / 2} textAnchor="end" dominantBaseline="central">{unitLabel(rack, b)}</text>
            <text className="rk-u" x={POST + inner + 14} y={y + UH / 2} textAnchor="start" dominantBaseline="central">{unitLabel(rack, b)}</text>
            {admin && !taken.has(b) && !drag && <rect className="rk-empty" x={POST} y={y} width={inner} height={UH} onClick={e => { e.stopPropagation(); onAddAt(unitLabel(rack, b)); }}><title>{`Add equipment at U${unitLabel(rack, b)}`}</title></rect>}
          </g>
        );
      })}
      {ghosts.map(d => place(d, true))}
      {solid.map(d => place(d, false))}
    </svg>
  );
}

/** Saves the drawing as a PNG: colours are copied from the page's styles so it looks the same anywhere, and pictures are embedded. */
export async function exportRack(svg: SVGSVGElement, name: string): Promise<void> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const live = [svg, ...svg.querySelectorAll("*")], copy = [clone, ...clone.querySelectorAll("*")];
  const props = ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "fill-opacity", "font-family", "font-size", "font-weight", "letter-spacing"];
  live.forEach((el, i) => {
    const cs = getComputedStyle(el), t = copy[i] as SVGElement;
    for (const p of props) { const v = cs.getPropertyValue(p); if (v) t.style.setProperty(p, v); }
    t.removeAttribute("class");
  });
  for (const img of Array.from(clone.querySelectorAll("image"))) {
    const href = img.getAttribute("href") ?? "";
    try {
      const blob = await (await fetch(href)).blob();
      const data = await new Promise<string>(res => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(blob); });
      img.setAttribute("href", data);
    } catch { img.remove(); }
  }
  clone.querySelectorAll("title").forEach(t => t.remove());
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const w = svg.viewBox.baseVal.width, h = svg.viewBox.baseVal.height, scale = 2;
  clone.setAttribute("width", String(w * scale)); clone.setAttribute("height", String(h * scale));
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    await new Promise<void>((res, rej) => { image.onload = () => res(); image.onerror = () => rej(new Error("The picture could not be made")); image.src = url; });
    const canvas = document.createElement("canvas");
    canvas.width = w * scale; canvas.height = h * scale;
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("The picture could not be made");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${name.replace(/[^\w.-]+/g, "-") || "rack"}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } finally { URL.revokeObjectURL(url); }
}
