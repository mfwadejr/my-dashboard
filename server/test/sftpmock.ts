import type { AddressInfo } from "node:net";
import ssh2, { type Connection } from "ssh2";

const { Server, utils } = ssh2;
const OK = 0, EOF = 1, NO_SUCH_FILE = 2, FAILURE = 4;

/** A tiny in-memory SFTP server for tests: one user, files kept in a Map keyed by full path. */
export async function mockSftp(user = "nas", pass = "secret") {
  const { private: hostKey } = utils.generateKeyPairSync("ed25519");
  const files = new Map<string, Buffer>(), dirs = new Set<string>(["/", "."]);
  const handles = new Map<string, { path: string; dir?: boolean; sent?: boolean }>();
  let counter = 0, logins = 0, denied = 0;
  const norm = (p: string) => p.replace(/\/+$/, "") || "/";
  const attrsOf = (p: string) => ({ mode: dirs.has(norm(p)) ? 0o040755 : 0o100644, uid: 0, gid: 0, size: files.get(p)?.length ?? 0, atime: 0, mtime: 0 });

  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    client.on("authentication", ctx => {
      if (ctx.method === "password" && ctx.username === user && ctx.password === pass) { logins++; return ctx.accept(); }
      denied++; ctx.reject(["password"]);
    });
    client.on("error", () => {});
    client.on("ready", () => {
      client.on("session", accept => {
        const session = accept();
        session.on("sftp", acceptSftp => {
          const sftp = acceptSftp();
          sftp.on("REALPATH", (id, p) => sftp.name(id, [{ filename: norm(p) === "." ? "/" : p, longname: p, attrs: {} as never }]));
          sftp.on("MKDIR", (id, p) => { if (dirs.has(norm(p))) return sftp.status(id, FAILURE); dirs.add(norm(p)); sftp.status(id, OK); });
          sftp.on("OPEN", (id, p) => { const h = `h${++counter}`; handles.set(h, { path: p }); files.set(p, Buffer.alloc(0)); sftp.handle(id, Buffer.from(h)); });
          sftp.on("WRITE", (id, h, off, data) => {
            const rec = handles.get(h.toString()); if (!rec) return sftp.status(id, FAILURE);
            const cur = files.get(rec.path) ?? Buffer.alloc(0), next = Buffer.alloc(Math.max(cur.length, off + data.length));
            cur.copy(next); data.copy(next, off); files.set(rec.path, next); sftp.status(id, OK);
          });
          sftp.on("FSTAT", (id, h) => { const rec = handles.get(h.toString()); rec ? sftp.attrs(id, attrsOf(rec.path)) : sftp.status(id, FAILURE); });
          sftp.on("FSETSTAT", id => sftp.status(id, OK));
          sftp.on("SETSTAT", id => sftp.status(id, OK));
          sftp.on("STAT", (id, p) => (files.has(p) || dirs.has(norm(p)) ? sftp.attrs(id, attrsOf(p)) : sftp.status(id, NO_SUCH_FILE)));
          sftp.on("LSTAT", (id, p) => (files.has(p) || dirs.has(norm(p)) ? sftp.attrs(id, attrsOf(p)) : sftp.status(id, NO_SUCH_FILE)));
          sftp.on("CLOSE", (id, h) => { handles.delete(h.toString()); sftp.status(id, OK); });
          sftp.on("RENAME", (id, from, to) => { const f = files.get(from); if (!f) return sftp.status(id, NO_SUCH_FILE); files.delete(from); files.set(to, f); sftp.status(id, OK); });
          sftp.on("REMOVE", (id, p) => { if (!files.delete(p)) return sftp.status(id, NO_SUCH_FILE); sftp.status(id, OK); });
          sftp.on("OPENDIR", (id, p) => { if (!dirs.has(norm(p))) return sftp.status(id, NO_SUCH_FILE); const h = `d${++counter}`; handles.set(h, { path: norm(p), dir: true }); sftp.handle(id, Buffer.from(h)); });
          sftp.on("READDIR", (id, h) => {
            const rec = handles.get(h.toString()); if (!rec) return sftp.status(id, FAILURE);
            if (rec.sent) return sftp.status(id, EOF);
            rec.sent = true;
            const prefix = rec.path === "/" ? "/" : rec.path + "/";
            const list = [...files.keys()].filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map(k => ({ filename: k.slice(prefix.length), longname: k, attrs: attrsOf(k) as never }));
            sftp.name(id, list);
          });
        });
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port, user, pass, files, dirs,
    get logins() { return logins; }, get denied() { return denied; },
    names: () => [...files.keys()].map(k => k.split("/").pop()!).sort(),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); })
  };
}
