// Device format verified against note_2026-11-02-07-46-02.opus:
// fixed 40-byte RFC 6716 packets, SILK wideband, mono, 20 ms.
// 4B 41 xx is Opus framing with padding, NOT a private "KA" header.
export function isRecorderOpus(bytes) {
  if (!bytes.length || bytes.length % 40) return false;
  for (let i = 0; i < bytes.length; i += 40) {
    if (bytes[i] === 0x48) continue; // One CBR frame, no padding.
    if (bytes[i] !== 0x4b) return false;
    if (bytes[i + 1] === 1) continue; // Code 3, one CBR frame.
    if (bytes[i + 1] !== 0x41 || bytes[i + 2] > 36) return false;
    // Code 3, one CBR frame, one padding-length byte.
  }
  return true;
}

function oggCrc(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}

export function recorderOpusToOgg(bytes) {
  if (!isRecorderOpus(bytes))
    throw new Error("不是已验证的 40 字节/20 ms 单声道 Opus 流，拒绝猜测包边界");
  const encoder = new TextEncoder();
  const pages = [];
  let sequence = 0;
  function page(packets, flags, granule) {
    // All packets here fit in one lacing segment (<255 bytes).
    const size = packets.reduce((sum, p) => sum + p.length, 0);
    const data = new Uint8Array(27 + packets.length + size);
    const view = new DataView(data.buffer);
    data.set(encoder.encode("OggS"));
    data[5] = flags;
    view.setBigUint64(6, BigInt(granule), true);
    view.setUint32(14, 0x56485542, true);
    view.setUint32(18, sequence++, true);
    data[26] = packets.length;
    let offset = 27 + packets.length;
    packets.forEach((packet, index) => {
      data[27 + index] = packet.length;
      data.set(packet, offset);
      offset += packet.length;
    });
    view.setUint32(22, oggCrc(data), true);
    pages.push(data);
  }
  const head = new Uint8Array(19);
  head.set(encoder.encode("OpusHead"));
  head[8] = 1;
  head[9] = 1;
  // Encoder lookahead is unknown: pre-skip=0 preserves all decoded samples.
  new DataView(head.buffer).setUint32(12, 16000, true);
  page([head], 2, 0);
  const vendor = encoder.encode("VoiceHub");
  const tags = new Uint8Array(16 + vendor.length);
  tags.set(encoder.encode("OpusTags"));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  page([tags], 0, 0);
  const count = bytes.length / 40;
  for (let first = 0; first < count; first += 50) {
    const end = Math.min(count, first + 50);
    const packets = [];
    for (let i = first; i < end; i++)
      packets.push(bytes.subarray(i * 40, (i + 1) * 40));
    // Ogg Opus granules always use the 48 kHz clock, even for wideband.
    page(packets, end === count ? 4 : 0, end * 960);
  }
  const output = new Uint8Array(pages.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const p of pages) {
    output.set(p, offset);
    offset += p.length;
  }
  return output;
}
