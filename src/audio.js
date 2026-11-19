// Only valid when each TYPE=1/CMD=1 body is one complete RFC 6716 Opus packet.
export function opusDuration(packet) {
  if (!packet.length) throw new Error("空 Opus 包");
  const toc = packet[0],
    config = toc >> 3;
  const ms =
    config >= 16
      ? 2.5 * (1 << (config & 3))
      : config >= 12
        ? 10 * (1 << (config & 1))
        : [10, 20, 40, 60][config & 3];
  const code = toc & 3;
  if (code === 3 && packet.length < 2) throw new Error("Opus 包缺少帧计数");
  const count = code === 0 ? 1 : code === 3 ? packet[1] & 63 : 2;
  if (!count || count * ms > 120)
    throw new Error("Opus 包时长无效；可能含私有包头或分包");
  return count * ms * 1000;
}
export class LiveAudio {
  constructor(onSamples, onError) {
    this.onSamples = onSamples;
    this.onError = onError;
    this.sources = new Set();
    this.pcm = [];
    this.samples = 0;
    this.timestamp = 0;
    this.enabled = false;
  }
  async enable() {
    if (typeof AudioDecoder === "undefined")
      throw new Error(
        "此浏览器不支持 WebCodecs AudioDecoder；仍可接收并导出原始流",
      );
    const config = { codec: "opus", sampleRate: 48000, numberOfChannels: 1 };
    if (!(await AudioDecoder.isConfigSupported(config)).supported)
      throw new Error("浏览器不支持 Opus 解码");
    this.stop();
    this.timestamp = 0;
    this.context = new AudioContext({ sampleRate: 48000 });
    await this.context.resume();
    this.nextTime = 0;
    this.decoder = new AudioDecoder({
      output: (data) => this.output(data),
      error: (e) => this.fail(e),
    });
    this.decoder.configure(config);
    this.enabled = true;
  }
  push(packet) {
    if (!this.enabled) return;
    try {
      if (this.decoder.decodeQueueSize > 80)
        throw new Error("解码积压过多，已关闭试听");
      const duration = opusDuration(packet);
      this.decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: this.timestamp,
          duration,
          data: packet,
        }),
      );
      this.timestamp += duration;
    } catch (e) {
      this.fail(e);
    }
  }
  output(data) {
    try {
      if (!this.enabled) return;
      const samples = new Float32Array(data.numberOfFrames);
      data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
      if (data.sampleRate !== 48000 || data.numberOfChannels !== 1)
        throw new Error("解码参数与单声道 48 kHz 不符，已关闭试听");
      if ((this.samples + samples.length) * 4 > 64 * 1024 * 1024)
        throw new Error("PCM 缓存达到 64 MiB，请导出 WAV 后重新开启试听");
      this.pcm.push(samples);
      this.samples += samples.length;
      this.onSamples(samples);
      const buffer = this.context.createBuffer(
        1,
        samples.length,
        data.sampleRate,
      );
      buffer.copyToChannel(samples, 0);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      this.nextTime = Math.max(this.context.currentTime + 0.06, this.nextTime);
      if (this.nextTime - this.context.currentTime > 1.5)
        this.nextTime = this.context.currentTime + 0.06;
      source.start(this.nextTime);
      this.nextTime += buffer.duration;
      this.sources.add(source);
      source.onended = () => this.sources.delete(source);
    } catch (e) {
      this.fail(e);
    } finally {
      data.close();
    }
  }
  fail(e) {
    this.stop();
    this.onError(
      new Error(
        `Opus 试听失败：${e.message}。原始音频继续接收，请核对固件包格式`,
      ),
    );
  }
  stop() {
    this.enabled = false;
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {}
    }
    this.sources.clear();
    if (this.context && this.context.state !== "closed")
      this.context.close().catch(() => {});
  }
  reset() {
    this.stop();
    this.pcm = [];
    this.samples = 0;
    this.timestamp = 0;
  }
  wav() {
    if (!this.samples) throw new Error("尚无成功解码的 PCM 音频");
    const bytes = new Uint8Array(44 + this.samples * 2),
      v = new DataView(bytes.buffer),
      enc = new TextEncoder();
    bytes.set(enc.encode("RIFF"));
    v.setUint32(4, bytes.length - 8, true);
    bytes.set(enc.encode("WAVEfmt "), 8);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 48000, true);
    v.setUint32(28, 96000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    bytes.set(enc.encode("data"), 36);
    v.setUint32(40, this.samples * 2, true);
    let offset = 44;
    for (const chunk of this.pcm)
      for (const sample of chunk) {
        v.setInt16(
          offset,
          Math.round(
            Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767),
          ),
          true,
        );
        offset += 2;
      }
    return bytes;
  }
}
// Portable capture: magic, metadata length LE, UTF-8 JSON, repeated length LE + payload.
export function packetCapture(chunks, packets, name) {
  const meta = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      name,
      codec: "unknown-opus-family",
      source: "AE22/TYPE1/CMD1",
      packets: packets.map((p) => ({
        length: p.length,
        time: p.time - (packets[0]?.time || 0),
      })),
    }),
  );
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode("VHSTREAM"));
  new DataView(header.buffer).setUint32(8, meta.length, true);
  return new Blob(
    [
      header,
      meta,
      ...chunks.flatMap((chunk) => {
        const size = new Uint8Array(4);
        new DataView(size.buffer).setUint32(0, chunk.length, true);
        return [size, chunk];
      }),
    ],
    { type: "application/octet-stream" },
  );
}
