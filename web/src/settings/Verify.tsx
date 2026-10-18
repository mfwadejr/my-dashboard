import type { VerifyReport } from "../types";

const MARK = { pass: "✓", warn: "!", fail: "✕" } as const;

/** The list of checks that were run, one line each, with a plain verdict on top. */
export function VerifyView({ report, title }: { report: VerifyReport; title?: string }) {
  return (
    <div className={`verify ${report.ok ? "good" : "badv"}`} role="status">
      <b>{title ? `${title}: ` : ""}{report.ok ? "Everything checked out" : "Problems found"}</b>
      <span className="sub"> {report.summary}</span>
      <ul className="checks">
        {report.checks.map(c => (
          <li key={c.id} className={c.status}><span className="mk" aria-label={c.status}>{MARK[c.status]}</span><span><b>{c.label}.</b> {c.detail}</span></li>
        ))}
      </ul>
    </div>
  );
}
