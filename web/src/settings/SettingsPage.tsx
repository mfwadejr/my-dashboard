import { useEffect } from "react";
import type { AboutInfo, AuthUser, CameraInfo, IntegrationInfo } from "../types";
import { About } from "./About";
import { Access } from "./Access";
import { Data } from "./Data";
import { General, type DevicePrefs } from "./General";
import { Sharing } from "./Sharing";
import { StatusLogs } from "./StatusLogs";

export const SECTIONS = [
  { id: "general", label: "General" }, { id: "data", label: "Data & backup" }, { id: "access", label: "Access" },
  { id: "sharing", label: "Sharing" }, { id: "status", label: "Status & log" }, { id: "about", label: "About" }
] as const;
export type SectionId = typeof SECTIONS[number]["id"];

export function SettingsPage({ section, onSection, me, device, integrations, cameras, about, openConnections, onRestored, onSignedOut }: {
  section: SectionId; onSection: (s: SectionId) => void; me: AuthUser; device: DevicePrefs; integrations: IntegrationInfo[]; cameras: CameraInfo[];
  about: AboutInfo | null; openConnections: () => void; onRestored: () => void; onSignedOut: () => void;
}) {
  useEffect(() => { window.scrollTo(0, 0); }, [section]);
  return (
    <div className="setpage" id="settings-top">
      <nav className="setnav" aria-label="Settings sections">
        {SECTIONS.map(s => <button key={s.id} className={s.id === section ? "on" : ""} aria-current={s.id === section ? "page" : undefined} onClick={() => onSection(s.id)}>{s.label}</button>)}
      </nav>
      <div className="setmain">
        {section === "general" && <General device={device} integrations={integrations} />}
        {section === "data" && <Data onRestored={onRestored} />}
        {section === "access" && <Access me={me} onSignedOut={onSignedOut} />}
        {section === "sharing" && <Sharing cameras={cameras} about={about} />}
        {section === "status" && <StatusLogs openConnections={openConnections} />}
        {section === "about" && <About about={about} />}
      </div>
    </div>
  );
}
