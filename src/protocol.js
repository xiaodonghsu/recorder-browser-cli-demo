// Reference: xiaodonghsu/recorder-python-cli-web-demo @ 789b88a.
export const UUID = Object.fromEntries(
  Object.entries({
    service: 0xae20,
    write: 0xae21,
    main: 0xae22,
    key: 0xae23,
  }).map(([k, v]) => [k, `0000${v.toString(16)}-0000-1000-8000-00805f9b34fb`]),
);
export const text = (bytes) => new TextDecoder().decode(bytes).split("\0")[0];
export const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
export function concat(chunks) {
  const result = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of chunks) {
    result.set(b, offset);
    offset += b.length;
  }
  return result;
}
export function parseHex(value) {
  const s = value.replace(/\s+/g, "");
  if (!/^(?:[a-f0-9]{2})*$/i.test(s))
    throw new Error("请输入完整的十六进制字节，例如 01 0A FF");
  return Uint8Array.from(s.match(/../g) || [], (b) => parseInt(b, 16));
}
export function authKey(value) {
  const s = value.trim();
  if (!/^(?:0x)?[a-f0-9]{64}$/i.test(s))
    throw new Error("AuthKey 必须是 64 位十六进制，可带 0x 前缀");
  return parseHex(s.replace(/^0x/i, ""));
}
export function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++)
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}
export function frame(seq, data) {
  if (!data.length || data.length > 8192)
    throw new Error("DATA 长度必须为 1–8192 字节");
  const bytes = new Uint8Array(data.length + 6);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x5a;
  bytes[1] = seq & 255;
  view.setUint16(4, data.length, true);
  bytes.set(data, 6);
  view.setUint16(2, crc16(bytes.subarray(4)), true);
  return bytes;
}
export const command = (seq, type, cmd, params = []) =>
  frame(seq, new Uint8Array([type, cmd, ...params]));
export function u32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new Error("偏移量必须为 0–4294967295 的整数");
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value, true);
  return b;
}
export function fixedName(name, length = 24) {
  const raw = new TextEncoder().encode(name);
  if (!name || raw.length > length)
    throw new Error(
      `文件名超过 ${length} 字节；请在协议设置切换长度，或指定正确文件名`,
    );
  const b = new Uint8Array(length);
  b.set(raw);
  return b;
}
export function importParams(name, offset = 0, nameLength = 24, end = null) {
  if (end !== null && end <= offset)
    throw new Error("分段结束偏移必须大于开始偏移");
  return concat([
    u32(offset),
    ...(end === null ? [] : [u32(end)]),
    fixedName(name, nameLength),
  ]);
}
export function syncTime(date = new Date()) {
  const b = new Uint8Array(7);
  new DataView(b.buffer).setUint16(0, date.getFullYear(), true);
  b.set(
    [
      date.getMonth() + 1,
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
    ],
    2,
  );
  return b;
}
export class FrameParser {
  constructor(onError = () => {}) {
    this.onError = onError;
    this.reset();
    this.crcErrors = 0;
  }
  reset() {
    this.buffer = new Uint8Array();
  }
  feed(chunk) {
    this.buffer = concat([this.buffer, chunk]);
    const frames = [];
    while (this.buffer.length) {
      const start = this.buffer.indexOf(0x5a);
      if (start < 0) {
        this.reset();
        break;
      }
      if (start) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < 6) break;
      const v = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        this.buffer.byteLength,
      );
      const len = v.getUint16(4, true);
      if (!len || len > 8192) {
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.length < len + 6) break;
      const raw = this.buffer.slice(0, len + 6);
      if (v.getUint16(2, true) !== crc16(raw.subarray(4))) {
        this.crcErrors++;
        this.onError("CRC 校验失败，已丢弃损坏帧并重新同步");
        this.buffer = this.buffer.slice(1);
        continue;
      }
      const data = raw.slice(6);
      frames.push({
        seq: raw[1],
        type: data[0],
        cmd: data.length > 1 ? data[1] : null,
        body: data.slice(2),
        raw,
      });
      this.buffer = this.buffer.slice(len + 6);
    }
    return frames;
  }
}
export function fileList(body, layout = "auto") {
  if (body.length < 4) throw new Error("文件列表缺少 count 字段");
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = v.getUint32(0, false);
  if (!count) {
    if (body.length !== 4) throw new Error("空文件列表长度异常");
    return [];
  }
  const entryLength =
    layout === "auto" ? (body.length - 4) / count : Number(layout);
  if (
    ![28, 33].includes(entryLength) ||
    body.length !== 4 + count * entryLength
  )
    throw new Error("列表长度不匹配；请检查 28B / 33B 协议设置");
  return Array.from({ length: count }, (_, i) => {
    const offset = 4 + i * entryLength;
    return {
      duration: v.getUint32(offset, false),
      size: v.getUint32(offset + 4, false),
      name: text(body.subarray(offset + 8, offset + entryLength)),
      raw: body.slice(offset, offset + entryLength),
    };
  });
}
export function candidateNames(name, preferred = "opus") {
  const base = name.replace(/\.(wav|opus|mp3)$/i, "").replace(/\.$/, "");
  return [
    ...new Set([
      `${base}.${preferred}`,
      `${base}.${preferred === "wav" ? "opus" : "wav"}`,
      name,
    ]),
  ];
}
export function inspectWav(bytes) {
  const fail = { isWav: false, valid: false };
  if (
    bytes.length < 12 ||
    text(bytes.subarray(0, 4)) !== "RIFF" ||
    text(bytes.subarray(8, 12)) !== "WAVE"
  )
    return fail;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt, dataSize;
  for (let p = 12; p + 8 <= bytes.length; ) {
    const size = v.getUint32(p + 4, true),
      id = text(bytes.subarray(p, p + 4));
    if (p + 8 + size > bytes.length) return { isWav: true, valid: false };
    if (id === "fmt " && size >= 16)
      fmt = {
        format: v.getUint16(p + 8, true),
        channels: v.getUint16(p + 10, true),
        sampleRate: v.getUint32(p + 12, true),
        bits: v.getUint16(p + 22, true),
      };
    if (id === "data") dataSize = size;
    p += 8 + size + (size & 1);
  }
  return {
    isWav: true,
    valid:
      v.getUint32(4, true) + 8 === bytes.length &&
      !!fmt &&
      dataSize !== undefined,
    ...fmt,
    dataSize,
  };
}
