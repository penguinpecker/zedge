// Key files of the house, the event house and the event's resolver (README "The key"): a regular file (not a link), mode 600,
// holding 0x and 64 hex digits. Nothing here prints a key.
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const refuse = (message) => { throw Object.assign(new Error(message), { refused: true }); };

export function readKey(file) {
  let st;
  try { st = lstatSync(file); } catch { refuse(`${file}: no key file there`); }
  if (!st.isFile() || (st.mode & 0o777) !== 0o600) refuse(`${file}: must be a regular file (not a link) with mode 600`);
  const key = readFileSync(file, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) refuse(`${file}: expected 0x and 64 hex digits`);
  return key;
}

/** A new key file that readKey takes. Never replaces a file. */
export function writeKey(file, key) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try { writeFileSync(file, `${key}\n`, { flag: "wx", mode: 0o600 }); } catch (e) { if (e.code === "EEXIST") refuse(`${file} exists; a key file is never replaced`); throw e; }
}
