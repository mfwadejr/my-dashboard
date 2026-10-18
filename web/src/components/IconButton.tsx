import { useState } from "react";
import { IconPicker } from "../dialogs/IconPicker";
import type { IconChoice } from "../types";
import { Icon } from "./Icon";

/** The current icon as a button; clicking opens the picker. `onChange` gets the new choice, or empty strings when the person picks letters. */
export function IconButton({ icon, iconRef, name, size = 28, onChange, label = "Choose icon" }: { icon?: string | null; iconRef?: string | null; name: string; size?: number; onChange: (v: IconChoice) => void | Promise<void>; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="icon-btn" title={label} aria-label={label} onClick={() => setOpen(true)}><Icon icon={icon} iconRef={iconRef} name={name} size={size} /></button>
      {open && <IconPicker current={icon} currentRef={iconRef} name={name} onClose={() => setOpen(false)} onPick={async v => { await onChange(v); setOpen(false); }} />}
    </>
  );
}
