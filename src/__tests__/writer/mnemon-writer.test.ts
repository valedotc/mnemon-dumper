import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMnemonFile } from "../../writer/mnemon-writer.js";
import {
  MAGIC,
  FORMAT_VERSION,
  HEADER_SIZE,
  SECTION_TABLE_ENTRY_SIZE,
  SECTION_ENTROPY,
  SECTION_TIMELINE,
} from "../../writer/format.js";

const TMP = join(tmpdir(), `mnemon-test-${process.pid}.mnem`);

after(async () => {
  try { await unlink(TMP); } catch {}
});

describe("writeMnemonFile", () => {
  test("returns the filepath", async () => {
    const result = await writeMnemonFile(TMP, []);
    assert.equal(result, TMP);
  });

  test("written file starts with MNEM magic", async () => {
    await writeMnemonFile(TMP, []);
    const buf = await readFile(TMP);
    assert.equal(buf.slice(0, 4).toString(), "MNEM");
  });

  test("header encodes version and section count", async () => {
    const sections = [
      { sectionId: SECTION_ENTROPY,  data: Buffer.alloc(8, 0x11) },
      { sectionId: SECTION_TIMELINE, data: Buffer.alloc(4, 0x22) },
    ];
    await writeMnemonFile(TMP, sections);
    const buf = await readFile(TMP);

    assert.ok(buf.slice(0, 4).equals(MAGIC));
    assert.equal(buf.readUInt16LE(4), FORMAT_VERSION);
    assert.equal(buf.readUInt16LE(6), 2); // section count
  });

  test("section table entries have correct sectionId", async () => {
    const sections = [
      { sectionId: SECTION_ENTROPY,  data: Buffer.alloc(8) },
      { sectionId: SECTION_TIMELINE, data: Buffer.alloc(4) },
    ];
    await writeMnemonFile(TMP, sections);
    const buf = await readFile(TMP);

    const tableOffset = buf.readUInt32LE(8);
    const entry0Id = buf.readUInt32LE(tableOffset);
    const entry1Id = buf.readUInt32LE(tableOffset + SECTION_TABLE_ENTRY_SIZE);
    assert.equal(entry0Id, SECTION_ENTROPY);
    assert.equal(entry1Id, SECTION_TIMELINE);
  });

  test("section data is correctly written", async () => {
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await writeMnemonFile(TMP, [{ sectionId: SECTION_ENTROPY, data: payload }]);
    const buf = await readFile(TMP);

    const tableOffset = buf.readUInt32LE(8);
    const dataOffset = buf.readUInt32LE(tableOffset + 4);
    const dataSize   = buf.readUInt32LE(tableOffset + 8);
    assert.equal(dataSize, 4);
    assert.ok(buf.slice(dataOffset, dataOffset + 4).equals(payload));
  });

  test("zero sections: file is valid with empty table", async () => {
    await writeMnemonFile(TMP, []);
    const buf = await readFile(TMP);
    assert.equal(buf.readUInt16LE(6), 0); // section count = 0
    // tableOffset points right after the header
    assert.equal(buf.readUInt32LE(8), HEADER_SIZE);
  });
});
