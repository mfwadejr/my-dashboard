import { useSettings, fmtDateTime } from "../settings";
import type { AboutInfo } from "../types";
import { Row, Section } from "./ui";

export function About({ about }: { about: AboutInfo | null }) {
  const { settings } = useSettings();
  return (
    <Section title="About this install" hint="Handy when you are updating: after you pull a new image, the commit here should change.">
      {!about ? <p className="sub">Loading…</p> : (
        <>
          <Row label="Version"><b>{about.version}</b></Row>
          <Row label="Build" hint="The short code of the change this image was made from."><code>{about.commit}</code></Row>
          <Row label="Built">{about.built ? new Date(about.built).toLocaleString([], { timeZone: settings.timezone }) : <span className="sub">Not recorded (a local build)</span>}</Row>
          <Row label="Started">{fmtDateTime(about.startedAt, settings)}</Row>
          <Row label="Runs on">Node {about.node.replace(/^v/, "")}</Row>
          <Row label="Camera relay">{about.go2rtc ? "Connected to go2rtc" : "Not set up"}</Row>
          <Row label="Sharing port">{about.publicPort ?? "Off"}</Row>
          <Row label="Source"><a href="https://github.com/mfwadejr/my-dashboard" target="_blank" rel="noreferrer">github.com/mfwadejr/my-dashboard</a></Row>
        </>
      )}
    </Section>
  );
}
