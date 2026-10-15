import { useEffect, useState } from "react";
import type { WidgetProps } from "./types";
import { Title } from "./common";

export function Notes({ tile, authed, setConfig }: WidgetProps) {
  const [text, setText] = useState(String(tile.config.text ?? ""));
  useEffect(() => { setText(String(tile.config.text ?? "")); }, [tile.config.text]);
  return (
    <>
      <Title>{tile.config.title ? String(tile.config.title) : "Notes"}</Title>
      <textarea className="notes" value={text} readOnly={!authed} spellCheck={false} placeholder={authed ? "Type a note…" : ""}
        onChange={e => { setText(e.target.value); setConfig({ text: e.target.value }); }} />
    </>
  );
}
