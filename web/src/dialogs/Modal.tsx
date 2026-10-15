import { useEffect, useRef, type ReactNode } from "react";

export function Modal({ title, eyebrow, onClose, children, wide }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className={wide ? "wide" : ""} onClose={onClose} onClick={e => { if (e.target === ref.current) ref.current?.close(); }}>
      <div className="dlg">
        <div className="dlg-head"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div><button className="btn sm" aria-label="Close" onClick={() => ref.current?.close()}>✕</button></div>
        {children}
      </div>
    </dialog>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
