// writer/format.ts

export const MAGIC = Buffer.from("MNEM");
export const FORMAT_VERSION = 1;

// Section IDs
export const SECTION_METADATA = 0x01;
export const SECTION_ENTROPY  = 0x02;
export const SECTION_STRINGS  = 0x03;
export const SECTION_TIMELINE = 0x04;
export const SECTION_RAWPAGES = 0x05;

// File header: 16 bytes total
// [0..3]   magic "MNEM"
// [4..5]   version (uint16 LE)
// [6..7]   section count (uint16 LE)
// [8..11]  section table offset (uint32 LE)
// [12..15] reserved (zeroes)

// Section table entry: 12 bytes each
// [0..3]   section ID (uint32 LE)
// [4..7]   data offset in file (uint32 LE)
// [8..11]  data size in bytes (uint32 LE)

export const HEADER_SIZE = 16;
export const SECTION_TABLE_ENTRY_SIZE = 12;
