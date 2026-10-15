import { useState } from "react";
import { Field, Modal } from "./Modal";

export function TabDialog({ tab, canDelete, onSave, onDelete, onClose }: {
  tab?: { name: string; emoji: string };
  canDelete: boolean;
  onSave: (v: { name: string; emoji: string; template: "blank" | "cameras" | "copy" }) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(tab?.name ?? "");
  const [emoji, setEmoji] = useState(tab?.emoji ?? "");
  const [template, setTemplate] = useState<"blank" | "cameras" | "copy">("blank");
  const [armed, setArmed] = useState(false);
  return (
    <Modal title={tab ? "Edit tab" : "New tab"} eyebrow="Tabs" onClose={onClose}>
      <form className="form" onSubmit={e => { e.preventDefault(); onSave({ name: name.trim() || "Untitled", emoji: emoji.trim(), template }); }}>
        <div className="row2"><Field label="Name"><input value={name} onChange={e => setName(e.target.value)} maxLength={60} autoFocus placeholder="Cameras" /></Field><Field label="Emoji (optional)"><input value={emoji} onChange={e => setEmoji(e.target.value)} maxLength={4} placeholder="📹" /></Field></div>
        {!tab && <Field label="Start from"><select value={template} onChange={e => setTemplate(e.target.value as any)}><option value="blank">Blank tab</option><option value="cameras">Camera wall (Outdoor and Indoor groups)</option><option value="copy">A copy of the current tab</option></select></Field>}
        <div className="acts"><span>{tab && canDelete && <button type="button" className="btn" onClick={() => (armed ? onDelete?.() : setArmed(true))}>{armed ? "Click again to delete" : "Delete tab"}</button>}</span><span className="acts-right"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn pri">Save</button></span></div>
      </form>
    </Modal>
  );
}
