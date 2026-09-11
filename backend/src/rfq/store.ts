// Durability for the RFQ book.
//
// The engine keeps its records in a Map, which is fine until the process stops.
// It did, mid-test: a restart during deployment wiped a live request while its
// 25-unit ATS hold carried on existing, because the hold lives on Hedera and
// the book did not. The seller was left with size escrowed against a request
// nobody could see, and no way to release it - the UI can only offer that
// button for a request it still knows about.
//
// So the book is snapshotted to disk after every change and read back at boot.
// A JSON file is the right size of tool here: the whole book is a few hundred
// records of plain strings, one venue writes it, and a hackathon judge should
// be able to `cat` it. Nothing in a RfqRecord is a Map, a Date or a bigint, so
// it round-trips through JSON unchanged - the engine already keeps amounts as
// decimal strings for exactly this kind of reason.
//
// Writes go to a temp file and are renamed over the target. rename(2) is atomic
// within a filesystem, so a crash mid-write leaves either the old book or the
// new one, never half of either.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RfqRecord } from './engine.js';

export class RfqStore {
  constructor(readonly path: string) {}

  load(): RfqRecord[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!Array.isArray(parsed)) {
        console.warn(`[store] ${this.path} is not an array of records; starting empty`);
        return [];
      }
      return parsed as RfqRecord[];
    } catch (e) {
      // A corrupt snapshot must not stop the venue from starting. Say so loudly
      // and carry on empty: the holds are still on-chain either way, and an API
      // that refuses to boot helps nobody.
      console.error(`[store] could not read ${this.path}:`, (e as Error).message);
      return [];
    }
  }

  save(records: RfqRecord[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(records, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (e) {
      // Losing durability is bad; losing the request in flight is worse. The
      // caller is mid-response, so this is reported and swallowed.
      console.error(`[store] could not write ${this.path}:`, (e as Error).message);
    }
  }
}
