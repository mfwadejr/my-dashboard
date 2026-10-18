import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Client, type SFTPWrapper } from "ssh2";
import type { SecretBox } from "./crypto.js";
import { ValidationError } from "./dashboard.js";
import { getMeta, logEvent, setMeta, type DB } from "./db.js";

/**
 * Network places that finished database copies are sent to, from inside Homebase (nothing is mounted in the container).
 * SFTP uses a built-in client. SMB uses the standard smbclient program, which understands SMB 3 signing and encryption.
 */
export type DestKind = "sftp" | "smb";
export interface Destination {
  id: string; name: string; kind: DestKind; host: string; port: number; share: string; path: string; username: string; domain: string;
  passwordSealed: string; hostKey: string; enabled: boolean; keep: number;
  lastAt: number | null; lastOk: boolean | null; lastMessage: string;
}
export interface DestinationView extends Omit<Destination, "passwordSealed"> { hasPassword: boolean }
export interface DestinationInput { name?: unknown; kind?: unknown; host?: unknown; port?: unknown; share?: unknown; path?: unknown; username?: unknown; domain?: unknown; password?: unknown; enabled?: unknown; keep?: unknown }

const COPY_NAME = /^homebase-\d{8}-\d{6}(-[a-z-]{1,20})?\.db$/;
const KEY = "backup_destinations";

interface Remote { put(localFile: string, remoteName: string): Promise<void>; list(): Promise<string[]>; del(name: string): Promise<void>; close(): void }

const text = (v: unknown, field: string, max: number, required = true): string => {
  const t = typeof v === "string" ? v.trim() : "";
  if (required && !t) throw new ValidationError(`${field} is required`);
  if (t.length > max) throw new ValidationError(`${field} is too long`);
  return t;
};

function validate(input: DestinationInput, old?: Destination): Omit<Destination, "id" | "passwordSealed" | "hostKey" | "lastAt" | "lastOk" | "lastMessage"> & { password: string } {
  const kind = (input.kind ?? old?.kind) as DestKind;
  if (kind !== "sftp" && kind !== "smb") throw new ValidationError("Choose SFTP or SMB");
  const name = text(input.name ?? old?.name, "The name", 40);
  const host = text(input.host ?? old?.host, "The server address", 253);
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) throw new ValidationError("The server address may only contain letters, numbers, dots, dashes and colons (no http:// or slashes)");
  const port = input.port === undefined || input.port === "" ? (old?.port ?? (kind === "sftp" ? 22 : 445)) : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ValidationError("The port must be a number from 1 to 65535");
  const share = kind === "smb" ? text(input.share ?? old?.share, "The share name", 80) : "";
  if (share && !/^[A-Za-z0-9 ._$-]+$/.test(share)) throw new ValidationError("The share name has characters that are not allowed");
  const path = text(input.path ?? old?.path ?? "", "The folder", 160, false).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (path && (!/^[A-Za-z0-9 ._/()-]+$/.test(path) || path.split("/").some(p => p === ".." || p === "."))) throw new ValidationError("The folder may only contain letters, numbers, spaces and . _ - ( ) / (no ..)");
  const username = text(input.username ?? old?.username, "The user name", 80);
  if (!/^[A-Za-z0-9._@\\$ -]+$/.test(username) || username.includes("%")) throw new ValidationError("The user name has characters that are not allowed");
  const domain = kind === "smb" ? text(input.domain ?? old?.domain ?? "", "The domain", 80, false) : "";
  if (domain && !/^[A-Za-z0-9._-]+$/.test(domain)) throw new ValidationError("The domain has characters that are not allowed");
  const keep = input.keep === undefined ? (old?.keep ?? 14) : Number(input.keep);
  if (!Number.isInteger(keep) || keep < 1 || keep > 365) throw new ValidationError("Copies to keep must be a whole number from 1 to 365");
  const password = typeof input.password === "string" ? input.password : "";
  if (password.length > 200) throw new ValidationError("The password is too long");
  return { name, kind, host, port, share, path, username, domain, enabled: input.enabled === undefined ? (old?.enabled ?? true) : Boolean(input.enabled), keep, password };
}

// ---- SFTP

function friendlySsh(error: unknown): string {
  const m = error instanceof Error ? error.message : String(error);
  if (/All configured authentication methods failed|Authentication failed/i.test(m)) return "The user name or password was not accepted.";
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return "That server name could not be found.";
  if (/ECONNREFUSED/.test(m)) return "The server refused the connection (is SFTP/SSH switched on, and is the port right?).";
  if (/ETIMEDOUT|Timed out|timeout/i.test(m)) return "The server did not answer in time.";
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return "The server cannot be reached from the container.";
  return m;
}

function sftpRemote(d: Destination, password: string, pin: { trust: boolean; found: string }): Promise<Remote> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let done = false;
    const fail = (e: unknown) => { if (!done) { done = true; try { client.end(); } catch { /* closed */ } reject(new Error(friendlySsh(e))); } };
    client.on("error", fail);
    client.on("ready", () => {
      client.sftp(async (err, sftp) => {
        if (err) return fail(err);
        try {
          const dir = d.path || ".";
          if (d.path) await mkdirs(sftp, d.path);
          const call = <T>(f: (cb: (e: Error | null | undefined, r: T) => void) => void) => new Promise<T>((res, rej) => f((e, r) => (e ? rej(e) : res(r))));
          const remote: Remote = {
            put: (file, name) => call<void>(cb => sftp.fastPut(file, `${dir}/${name}.part`, cb as never)).then(() => call<void>(cb => sftp.rename(`${dir}/${name}.part`, `${dir}/${name}`, cb as never))),
            list: async () => (await call<Array<{ filename: string }>>(cb => sftp.readdir(dir, cb as never))).map(e => e.filename),
            del: name => call<void>(cb => sftp.unlink(`${dir}/${name}`, cb as never)),
            close: () => { try { client.end(); } catch { /* closed */ } }
          };
          done = true; resolve(remote);
        } catch (e) { fail(e); }
      });
    });
    client.connect({
      host: d.host, port: d.port, username: d.username, password, readyTimeout: 12_000, hostHash: "sha256",
      hostVerifier: (hash: string) => {
        pin.found = hash;
        if (d.hostKey) return d.hostKey === hash;
        return pin.trust;
      }
    });
  });
}

async function mkdirs(sftp: SFTPWrapper, path: string): Promise<void> {
  let cur = "";
  for (const part of path.split("/")) {
    cur = cur ? `${cur}/${part}` : part;
    await new Promise<void>(res => sftp.mkdir(cur, () => res())); // already existing is fine; a real problem shows up on the first upload
  }
}

// ---- SMB through smbclient

function friendlySmb(output: string, code: unknown): string {
  if (code === "ENOENT") return "smbclient is not installed in this container, so SMB copies are not available here. Use SFTP, or use the official Homebase image.";
  if (/NT_STATUS_LOGON_FAILURE|NT_STATUS_WRONG_PASSWORD|NT_STATUS_NO_SUCH_USER|NT_STATUS_ACCOUNT_DISABLED/.test(output)) return "The user name or password was not accepted.";
  if (/NT_STATUS_BAD_NETWORK_NAME/.test(output)) return "The server does not have a share with that name.";
  if (/NT_STATUS_ACCESS_DENIED/.test(output)) return "This account is not allowed to write to that share or folder.";
  if (/NT_STATUS_OBJECT_PATH_NOT_FOUND|NT_STATUS_OBJECT_NAME_NOT_FOUND/.test(output)) return "That folder was not found on the share.";
  if (/NT_STATUS_CONNECTION_REFUSED|Connection to .* failed|NT_STATUS_HOST_UNREACHABLE|NT_STATUS_UNSUCCESSFUL.*connect|NT_STATUS_IO_TIMEOUT/i.test(output)) return "The server could not be reached on that port.";
  if (/NT_STATUS_UNSUPPORTED|NT_STATUS_NOT_SUPPORTED|NT_STATUS_INVALID_NETWORK_RESPONSE|Protocol negotiation failed|NT_STATUS_PROTOCOL/i.test(output)) return "Homebase and the server could not agree on an SMB version or security setting (signing or encryption). Try SFTP instead.";
  if (/NT_STATUS_DISK_FULL|NT_STATUS_QUOTA/.test(output)) return "The destination is full.";
  const line = output.split("\n").map(l => l.trim()).find(l => /NT_STATUS|failed|error/i.test(l));
  return line ? `The server said: ${line.slice(0, 200)}` : "The copy did not work.";
}

function runSmb(d: Destination, password: string, commands: string, timeoutMs: number): Promise<string> {
  const args = [`//${d.host}/${d.share}`, "-p", String(d.port), "-U", d.username, "-c", commands];
  if (d.domain) args.push("-W", d.domain);
  return new Promise((resolve, reject) => {
    execFile("smbclient", args, { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PASSWD: password, LANG: "C" }, timeout: timeoutMs, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`;
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error(friendlySmb(out, "ENOENT")));
      if (error && (error as { killed?: boolean }).killed) return reject(new Error("The server did not answer in time."));
      if (error || /NT_STATUS_[A-Z_]+/.test(out)) return reject(new Error(friendlySmb(out, (error as NodeJS.ErrnoException | null)?.code)));
      resolve(out);
    });
  });
}

function smbRemote(d: Destination, password: string): Remote {
  const cd = d.path ? `cd "${d.path}"; ` : "";
  return {
    async put(file, name) {
      if (d.path) { // create each folder level; "already exists" is expected, so this call's result is ignored
        let cur = "";
        const mk = d.path.split("/").map(p => { cur = cur ? `${cur}/${p}` : p; return `mkdir "${cur}"`; }).join("; ");
        await runSmb(d, password, mk, 30_000).catch(() => undefined);
      }
      await runSmb(d, password, `${cd}put "${file.replace(/"/g, "")}" "${name}"`, 600_000);
    },
    async list() {
      const out = await runSmb(d, password, `${cd}ls homebase-*.db`, 60_000);
      return [...out.matchAll(/^\s*(homebase-\S+\.db)\s/gm)].map(m => m[1]);
    },
    async del(name) { await runSmb(d, password, `${cd}del "${name}"`, 60_000); },
    close() { /* each smbclient call is its own connection */ }
  };
}

export class Destinations {
  constructor(private db: DB, private box: SecretBox) {}

  private all(): Destination[] {
    try { const v = JSON.parse(getMeta(this.db, KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  private save(list: Destination[]): void { setMeta(this.db, KEY, JSON.stringify(list)); }
  private patch(id: string, fields: Partial<Destination>): void {
    const list = this.all(), i = list.findIndex(d => d.id === id);
    if (i >= 0) { list[i] = { ...list[i], ...fields }; this.save(list); }
  }

  view(d: Destination): DestinationView { const { passwordSealed, ...rest } = d; return { ...rest, hasPassword: Boolean(passwordSealed) }; }
  list(): DestinationView[] { return this.all().map(d => this.view(d)); }
  get(id: string): Destination | undefined { return this.all().find(d => d.id === id); }

  create(input: DestinationInput): DestinationView {
    const v = validate(input);
    if (!v.password) throw new ValidationError("The password is required");
    const d: Destination = { id: randomUUID().slice(0, 8), ...v, passwordSealed: this.box.seal(v.password), hostKey: "", lastAt: null, lastOk: null, lastMessage: "Not tested yet" } as Destination;
    delete (d as unknown as { password?: string }).password;
    this.save([...this.all(), d]);
    return this.view(d);
  }

  update(id: string, input: DestinationInput): DestinationView {
    const old = this.get(id);
    if (!old) throw new ValidationError("That destination no longer exists");
    const v = validate(input, old);
    const moved = v.host !== old.host || v.port !== old.port || v.kind !== old.kind;
    const next: Destination = { ...old, ...v, passwordSealed: v.password ? this.box.seal(v.password) : old.passwordSealed, hostKey: moved ? "" : old.hostKey };
    delete (next as unknown as { password?: string }).password;
    this.patch(id, next);
    return this.view(next);
  }

  remove(id: string): boolean { const list = this.all(); const rest = list.filter(d => d.id !== id); this.save(rest); return rest.length !== list.length; }

  private async connect(d: Destination, trust = false): Promise<Remote> {
    const password = this.box.open(d.passwordSealed);
    if (d.kind === "smb") return smbRemote(d, password);
    if (!d.hostKey && !trust) throw new Error("Run Test first so Homebase can learn this server's identity.");
    const pin = { trust, found: "" };
    try { return await sftpRemote(d, password, pin); }
    catch (e) {
      if (d.hostKey && pin.found && pin.found !== d.hostKey) throw new Error("The server's identity changed since it was first trusted. This could mean someone is intercepting the connection, or the server was reinstalled. Edit the destination and save it to trust the new identity.");
      throw e;
    }
  }

  /** Writes and removes a small file, so a pass means copies will really arrive. For SFTP this also records the server's identity the first time. */
  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const d = this.get(id);
    if (!d) throw new ValidationError("That destination no longer exists");
    let remote: Remote | null = null;
    try {
      const firstTime = d.kind === "sftp" && !d.hostKey;
      let learned = d.hostKey;
      if (d.kind === "sftp") {
        const pin = { trust: firstTime, found: "" };
        try { remote = await sftpRemote(d, this.box.open(d.passwordSealed), pin); }
        catch (e) {
          if (d.hostKey && pin.found && pin.found !== d.hostKey) throw new Error("The server's identity changed since it was first trusted. Edit the destination and save it to trust the new identity, but only if you expected the change.");
          throw e;
        }
        learned = pin.found || d.hostKey;
        if (firstTime && learned) this.patch(id, { hostKey: learned });
      } else remote = await this.connect(d, true);
      const probe = `homebase-00000000-000000-test.db`;
      const dir = mkdtempSync(join(tmpdir(), "hb-dest-"));
      try {
        writeFileSync(join(dir, probe), "Homebase connection test");
        await remote.put(join(dir, probe), probe);
        await remote.del(probe);
      } finally { rmSync(dir, { recursive: true, force: true }); }
      const fp = d.kind === "sftp" && learned ? ` Server identity: SHA256:${Buffer.from(learned, "hex").toString("base64").replace(/=+$/, "")}${firstTime ? " (now trusted)" : ""}.` : "";
      const message = `Connected, and a test file was written and removed.${fp}`;
      this.patch(id, { lastAt: Date.now(), lastOk: true, lastMessage: message });
      return { ok: true, message };
    } catch (e) {
      const message = e instanceof Error ? e.message : "The test failed";
      this.patch(id, { lastAt: Date.now(), lastOk: false, lastMessage: message });
      return { ok: false, message };
    } finally { remote?.close(); }
  }

  /** Sends one finished database copy, then removes the oldest copies there beyond the number to keep. */
  async send(id: string, file: string, name = basename(file), actor = "Homebase"): Promise<{ ok: boolean; message: string }> {
    const d = this.get(id);
    if (!d) throw new ValidationError("That destination no longer exists");
    if (!COPY_NAME.test(name)) throw new ValidationError("That is not a Homebase database copy");
    let remote: Remote | null = null;
    try {
      remote = await this.connect(d);
      await remote.put(file, name);
      let removed = 0;
      try {
        const names = (await remote.list()).filter(n => COPY_NAME.test(n) && !n.includes("-test")).sort().reverse();
        for (const old of names.slice(d.keep)) { await remote.del(old); removed++; }
      } catch { /* the copy arrived; tidying up is best effort */ }
      const kb = Math.max(1, Math.round(statSync(file).size / 1024));
      const message = `Sent ${name} (${kb} KB)${removed ? `; removed ${removed} older copy(ies) there` : ""}.`;
      this.patch(id, { lastAt: Date.now(), lastOk: true, lastMessage: message });
      logEvent(this.db, "info", "backup", `${actor} sent a database copy to "${d.name}" (${d.kind.toUpperCase()}): ${message}`);
      return { ok: true, message };
    } catch (e) {
      const message = e instanceof Error ? e.message : "The copy failed";
      this.patch(id, { lastAt: Date.now(), lastOk: false, lastMessage: message });
      logEvent(this.db, "error", "backup", `Sending a database copy to "${d.name}" (${d.kind.toUpperCase()}) failed: ${message}`);
      return { ok: false, message };
    } finally { remote?.close(); }
  }

  /** After a scheduled copy: every switched-on destination gets it. Failures are logged, never thrown. */
  async sendAll(file: string, name: string): Promise<void> {
    for (const d of this.all().filter(x => x.enabled)) { try { await this.send(d.id, file, name); } catch { /* logged inside */ } }
  }
}
