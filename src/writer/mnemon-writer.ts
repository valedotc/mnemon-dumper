// writer/mnemon-writer.ts

import { open, mkdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MAGIC,
  FORMAT_VERSION,
  HEADER_SIZE,
  SECTION_TABLE_ENTRY_SIZE,
} from "./format.js";

export interface SectionData {
  sectionId: number;
  data: Buffer | null;
  // Streaming alternative for sections that exceed the 2GB Buffer limit.
  // Called instead of writing data; must return bytes written.
  writeStream?: (fh: FileHandle) => Promise<number>;
}

/**
 * Writes a .mnem binary file to the given filepath.
 *
 * Sections may supply either a pre-built Buffer via `data` or a streaming
 * callback via `writeStream` (used by RawPagesExtractor to avoid the 2GB
 * Buffer.concat limit). The two fields are mutually exclusive; `writeStream`
 * takes precedence.
 *
 * Writing order:
 *   1. 16 zero bytes — placeholder header (position 0)
 *   2. Section data blocks, written sequentially; record each section's
 *      dataOffset as we go
 *   3. Section table (12 bytes × N) at the current end of file
 *   4. Seek back to position 0 and overwrite with the real header,
 *      which now knows the correct sectionTableOffset
 *
 * The parent directory is created if it does not exist.
 * Returns the resolved filepath.
 */
export async function writeMnemonFile(
  filepath: string,
  sections: SectionData[],
): Promise<string> {
  await mkdir(dirname(filepath), { recursive: true });

  const fh = await open(filepath, "w");
  try {
    // 1. Placeholder header (will be overwritten at step 4)
    await fh.write(Buffer.alloc(HEADER_SIZE), 0, HEADER_SIZE, null);

    // 2. Section data blocks
    const tableEntries: Array<{
      sectionId: number;
      offset: number;
      size: number;
    }> = [];
    let pos = HEADER_SIZE;

    for (const s of sections) {
      const startPos = pos;
      let size: number;

      if (s.writeStream) {
        size = await s.writeStream(fh);
      } else {
        const d = s.data!;
        size = d.length;
        await fh.write(d, 0, size, null);
      }

      tableEntries.push({ sectionId: s.sectionId, offset: startPos, size });
      pos += size;
    }

    // 3. Section table at end of file
    const tableOffset = pos;
    for (const entry of tableEntries) {
      const buf = Buffer.allocUnsafe(SECTION_TABLE_ENTRY_SIZE);
      buf.writeUInt32LE(entry.sectionId, 0);
      buf.writeUInt32LE(entry.offset, 4);
      buf.writeUInt32LE(entry.size, 8);
      await fh.write(buf, 0, SECTION_TABLE_ENTRY_SIZE, null);
    }

    // 4. Seek back to position 0 and write the real header
    const header = Buffer.allocUnsafe(HEADER_SIZE);
    MAGIC.copy(header, 0);
    header.writeUInt16LE(FORMAT_VERSION, 4);
    header.writeUInt16LE(sections.length, 6);
    header.writeUInt32LE(tableOffset, 8);
    header.writeUInt32LE(0, 12); // reserved
    await fh.write(header, 0, HEADER_SIZE, 0);
  } finally {
    await fh.close();
  }

  return filepath;
}
