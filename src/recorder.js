import {
  UUID,
  FrameParser,
  command,
  hex,
  text,
  authKey,
  fileList,
  candidateNames,
  importParams,
  concat,
  inspectWav,
  syncTime,
} from "./protocol.js";
import { bluetoothEnvironmentIssue } from "./environment.js";

const MAX_FILE = 256 * 1024 * 1024;
const MAX_LIVE = 128 * 1024 * 1024;
const MAX_LIVE_PACKETS = 200000;
export class Recorder extends EventTarget {
  constructor(bluetooth = globalThis.navigator?.bluetooth) {
    super();
    this.bluetooth = bluetooth;
    this.seq = 0;
    this.pending = new Set();
    this.subscriptions = [];
    this.writeQueue = Promise.resolve();
    this.requestQueue = Promise.resolve();
    this.generation = 0;
    this.settings = { nameLength: 29, listLayout: "auto", legacyRecord: false };
    this.state = {
      connected: false,
      authenticated: false,
      recording: null,
      live: "stopped",
      bytes: 0,
      packets: 0,
      crcErrors: 0,
    };
    this.liveChunks = [];
    this.livePackets = [];
    this.files = [];
  }
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  update(patch) {
    Object.assign(this.state, patch);
    this.emit("state", { ...this.state });
  }
  log(level, message) {
    this.emit("log", { time: new Date().toISOString(), level, message });
  }
  async connect(compat = false) {
    if (!this.bluetooth)
      throw new Error(
        bluetoothEnvironmentIssue() ||
          "当前页面未获得 Web Bluetooth API，请检查浏览器环境与权限",
      );
    if (this.state.connected || this.connecting)
      throw new Error("已有连接或正在连接");
    this.connecting = true;
    try {
      // Must be called directly inside a user gesture, before any await.
      const device = await this.bluetooth.requestDevice(
        compat
          ? { acceptAllDevices: true, optionalServices: [UUID.service] }
          : {
              filters: [
                { services: [UUID.service] },
                ...["CB08", "QS668", "CAC10"].map((namePrefix) => ({
                  namePrefix,
                })),
              ],
              optionalServices: [UUID.service],
            },
      );
      this.device = device;
      this.disconnected = () => this.cleanup("蓝牙连接已断开");
      device.addEventListener("gattserverdisconnected", this.disconnected);
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(UUID.service);
      this.writeChar = await service.getCharacteristic(UUID.write);
      await this.subscribe(service, UUID.main, "AE22");
      try {
        await this.subscribe(service, UUID.key, "AE23");
      } catch (e) {
        this.log("WARN", `AE23 未订阅：${e.message}；机身按键事件可能不可用`);
      }
      this.transferUncertain = false;
      this.update({
        connected: true,
        name: device.name || "未命名录音卡",
        id: device.id,
      });
      this.log("OK", `已连接 ${device.name || device.id}，AE22 通知已就绪`);
    } catch (e) {
      this.device?.gatt?.disconnect();
      this.cleanup("连接未建立");
      throw e;
    } finally {
      this.connecting = false;
    }
  }
  async subscribe(service, uuid, source) {
    const characteristic = await service.getCharacteristic(uuid);
    const parser = new FrameParser((message) => {
      this.update({ crcErrors: this.state.crcErrors + 1 });
      this.log("WARN", `${source} ${message}`);
    });
    const listener = (event) => {
      const v = event.target.value;
      for (const f of parser.feed(
        new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
      )) {
        try {
          this.handle(f, source);
        } catch (e) {
          this.log("ERR", `应答解析失败：${e.message}`);
          if (f.type === 2 && f.cmd === 1)
            this.listSession?.finish(new Error(e.message));
        }
      }
    };
    characteristic.addEventListener("characteristicvaluechanged", listener);
    this.subscriptions.push({ characteristic, listener, parser });
    await characteristic.startNotifications();
  }
  disconnect() {
    this.device?.gatt?.disconnect();
    this.cleanup("主动断开连接");
  }
  cleanup(reason) {
    this.generation++;
    for (const p of [...this.pending]) p.reject(new Error(reason));
    this.listSession?.finish(new Error(reason));
    this.downloadSession?.finish(new Error(reason));
    for (const { characteristic, listener, parser } of this.subscriptions) {
      characteristic.removeEventListener(
        "characteristicvaluechanged",
        listener,
      );
      parser.reset();
    }
    this.subscriptions = [];
    if (this.device && this.disconnected)
      this.device.removeEventListener(
        "gattserverdisconnected",
        this.disconnected,
      );
    this.writeChar = null;
    this.update({
      connected: false,
      authenticated: false,
      recording: null,
      live: "stopped",
      battery: null,
      capacity: null,
      version: null,
      filename: null,
      gain: null,
      duration: null,
    });
    this.files = [];
    this.emit("files", []);
  }
  write(bytes) {
    const generation = this.generation,
      char = this.writeChar;
    const task = this.writeQueue
      .catch(() => {})
      .then(async () => {
        if (!this.state.connected || !char || generation !== this.generation)
          throw new Error("蓝牙未连接");
        // Never split application frames: AuthKey / file import must be atomic.
        try {
          if (char.properties.writeWithoutResponse)
            await char.writeValueWithoutResponse(bytes);
          else if (char.properties.write)
            await char.writeValueWithResponse(bytes);
          else throw new Error("AE21 不支持写入");
        } catch (e) {
          throw new Error(
            `GATT 整帧写入 ${bytes.length}B 失败：${e.message}。浏览器无法手动设置 MTU，请重连或检查蓝牙适配器`,
          );
        }
        const sensitive = bytes[6] === 0 && [50, 52].includes(bytes[7]);
        this.log(
          "TX",
          sensitive
            ? `0-${bytes[7]} AuthKey [已隐藏] · ${bytes.length}B`
            : hex(bytes),
        );
      });
    this.writeQueue = task;
    return task;
  }
  send(type, cmd, params = []) {
    return this.write(command(this.seq++ & 255, type, cmd, params));
  }
  request(type, cmd, params = [], responses = [cmd + 1], timeout = 5000) {
    const generation = this.generation;
    const task = this.requestQueue
      .catch(() => {})
      .then(() => {
        if (generation !== this.generation || !this.state.connected)
          throw new Error("蓝牙连接已变化，请重试");
        return new Promise((resolve, reject) => {
          const done = (error, value) => {
            clearTimeout(timer);
            this.pending.delete(p);
            error ? reject(error) : resolve(value);
          };
          const p = {
            type,
            responses,
            resolve: (f) => done(null, f),
            reject: (e) => done(e),
          };
          const timer = setTimeout(
            () =>
              p.reject(
                new Error(`${type}-${cmd} 等待应答超时，尚未确认设备操作结果`),
              ),
            timeout,
          );
          this.pending.add(p);
          this.send(type, cmd, params).catch(p.reject);
        });
      });
    this.requestQueue = task;
    return task;
  }
  handle(f, source) {
    const { type, cmd, body } = f;
    const bulk = (type === 1 && cmd === 1) || (type === 2 && cmd === 4);
    if (!bulk)
      this.log(
        "RX",
        `${source} seq=${f.seq} ${type}-${cmd ?? "ACK"} ${type === 0 && [13, 51, 53, 55].includes(cmd) ? "[敏感应答已隐藏]" : hex(body)}`,
      );
    if (cmd === null) return;
    // TYPE-only ACK never completes a command request.
    for (const p of this.pending)
      if (p.type === type && p.responses.includes(cmd)) {
        p.resolve(f);
        break;
      }
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    if (type === 0) {
      if (cmd === 4 && body.length) this.update({ battery: body[0] });
      if (cmd === 2 && body.length >= 8)
        this.update({
          capacity: {
            free: v.getUint32(0, true) * 1024,
            total: v.getUint32(4, true) * 1024,
          },
        });
      if (cmd === 11) this.update({ version: text(body) });
    }
    if (type === 3) {
      if (cmd === 20 && body.length) this.update({ recording: body[0] });
      if (cmd === 22 && body.length >= 6)
        this.update({
          duration: v.getUint16(0, true),
          recordSize: v.getUint32(2, true),
        });
      if (cmd === 24) this.update({ filename: text(body) });
      if (cmd === 26 && body.length) this.update({ gain: body[0] });
      if ([1, 3, 5, 7].includes(cmd)) {
        this.log("INFO", `机身录音事件 ${cmd}`);
        this.update({ recording: { 1: 1, 3: 2, 5: 3, 7: 1 }[cmd] });
      }
    }
    if (type === 2 && this.listSession) {
      if (cmd === 1) {
        this.listSession.entries.push(
          ...fileList(body, this.settings.listLayout),
        );
        this.listSession.arm();
      }
      if (cmd === 18)
        this.listSession.finish(
          body[0] === 0 ? null : new Error("文件列表结束状态异常"),
        );
    }
    const dl = this.downloadSession;
    if (type === 2 && dl) {
      if (cmd === 3) {
        dl.deviceName = text(body);
        dl.arm();
      }
      if (cmd === 4) {
        if (dl.bytes + body.length > MAX_FILE) {
          dl.finish(new Error("文件接收超过 256 MiB 内存限制，请使用分段下载"));
          return;
        }
        dl.chunks.push(body);
        dl.bytes += body.length;
        dl.arm();
        this.emit("progress", {
          bytes: dl.bytes,
          name: dl.name,
          expected: dl.expected,
        });
      }
      if (cmd === 5) {
        const code = body[0] ?? 3;
        if (!code) dl.finish();
        else
          dl.finish(
            Object.assign(
              new Error(
                ["", "设备未找到文件", "偏移量过大", "设备停止传输"][code] ||
                  `导入结束码 ${code}`,
              ),
              { code, ended: true },
            ),
          );
      }
    }
    if (type === 1) {
      if (cmd === 0 && this.state.live !== "stopped")
        this.update({ liveName: text(body), live: "streaming" });
      if (cmd === 1) {
        if (this.state.live === "stopped") return;
        if (
          this.state.bytes + body.length > MAX_LIVE ||
          this.state.packets >= MAX_LIVE_PACKETS
        ) {
          this.update({ live: "stopped" });
          this.send(1, 2).catch((e) => this.log("ERR", e.message));
          this.log(
            "WARN",
            "实时缓存达到 128 MiB 或 200000 包限制，已停止接收，请导出后开启新会话",
          );
          return;
        }
        this.liveChunks.push(body);
        this.livePackets.push({ length: body.length, time: performance.now() });
        this.state.bytes += body.length;
        this.state.packets++;
        if (["starting", "waiting"].includes(this.state.live))
          this.update({ live: "streaming" });
        this.emit("audio", body); // UI refresh is throttled separately.
      }
      if (cmd === 4 && this.state.live !== "stopped")
        this.update({
          live:
            { 0: "streaming", 1: "paused", 2: "stopped" }[body[0]] || "unknown",
        });
    }
  }
  async authenticate(value) {
    const key = authKey(value);
    this.update({ authenticated: false });
    const f = await this.request(0, 50, key, [51]);
    if (f.body[0] !== 0)
      throw new Error(`AuthKey 鉴权未通过（${f.body[0] ?? "空应答"}）`);
    this.update({ authenticated: true });
    this.log("OK", "AuthKey 鉴权通过");
  }
  async refresh() {
    if (!this.state.authenticated)
      throw new Error("请先完成设备授权，再获取设备信息");
    for (const [type, cmd] of [
      [0, 3],
      [0, 1],
      [0, 10],
      [3, 19],
      [3, 21],
      [3, 23],
      [3, 25],
    ]) {
      if (!this.state.connected || !this.state.authenticated) break;
      try {
        await this.request(type, cmd);
      } catch (e) {
        this.log("WARN", e.message);
      }
      if (!this.state.connected) break;
    }
  }
  syncClock() {
    return this.send(0, 0, syncTime());
  }
  async record(action) {
    const mapping = {
      start: [1, 2],
      save: [3, 4],
      pause: [5, 6],
      resume: [7, 8],
    };
    const [cmd, response] = mapping[action];
    const f = await this.request(
      3,
      cmd,
      [],
      this.settings.legacyRecord ? [response, 0] : [response],
    );
    if (f.cmd !== 0 && f.body[0] !== 1)
      throw new Error(`录音操作失败（${f.body[0] ?? "空应答"}）`);
    if (f.cmd === 0)
      this.log("WARN", "收到旧版 3-0 通用应答，继续查询真实录音状态");
    await this.request(3, 19, [], [20]);
  }
  async gain(level) {
    if (![1, 2, 3].includes(level)) throw new Error("增益必须为 1–3");
    const f = await this.request(3, 27, [level], [28]);
    if (f.body[0] !== 0) throw new Error("设置增益失败");
    await this.request(3, 25);
  }
  getFiles() {
    if (!this.state.connected)
      return Promise.reject(new Error("请先连接录音卡"));
    if (this.listSession || this.downloadBusy)
      return Promise.reject(new Error("文件操作进行中，请稍后重试"));
    return new Promise((resolve, reject) => {
      let idle, deadline;
      const s = {
        entries: [],
        arm: () => {
          clearTimeout(idle);
          idle = setTimeout(() => s.finish(null, true), 1500);
        },
        finish: (error, inferred = false) => {
          if (this.listSession !== s) return;
          clearTimeout(idle);
          clearTimeout(deadline);
          this.listSession = null;
          if (error) reject(error);
          else {
            this.files = s.entries;
            this.emit("files", this.files);
            this.log(
              inferred ? "WARN" : "OK",
              inferred
                ? `列表空闲收尾，共 ${s.entries.length} 条（未收到结束帧，可能不完整）`
                : `列表完成，共 ${s.entries.length} 条`,
            );
            resolve(this.files);
          }
        },
      };
      this.listSession = s;
      deadline = setTimeout(
        () => s.finish(new Error("文件列表请求超时")),
        15000,
      );
      this.send(2, 0).then(
        () => {
          if (this.listSession === s) s.arm();
        },
        (e) => s.finish(e),
      );
    });
  }
  async download(
    entry,
    { name, offset = 0, end = null, preferred = "opus", resume = false } = {},
  ) {
    if (!this.state.connected) throw new Error("请先连接录音卡");
    if (this.downloadBusy || this.listSession)
      throw new Error("已有文件操作进行中");
    if (this.transferUncertain)
      throw new Error("上次传输未确认结束，请断开重连后再下载");
    this.downloadBusy = true;
    try {
      const partial = this.partial;
      if (resume) {
        if (
          !partial ||
          partial.deviceId !== this.device?.id ||
          partial.entry.name !== entry.name ||
          partial.segment ||
          !partial.bytes
        )
          throw new Error("没有当前设备该文件可续传的缓存");
        name = partial.name;
        offset = partial.bytes;
      }
      const names =
        name || offset || end !== null
          ? [name || candidateNames(entry.name, preferred)[0]]
          : candidateNames(entry.name, preferred);
      let last;
      for (const current of names) {
        // Validation happens before any TX, including filename length.
        let params;
        try {
          params = importParams(current, offset, this.settings.nameLength, end);
        } catch (e) {
          last = e;
          if (names.length === 1) throw e;
          continue;
        }
        try {
          return await this.downloadOnce(
            entry,
            current,
            params,
            end,
            resume ? partial : null,
            offset,
          );
        } catch (e) {
          last = e;
          if (e.code !== 1 || e.received || offset) throw e;
          this.log("WARN", `${current} 不存在，尝试下一个候选文件名`);
        }
      }
      throw last || new Error("无可用文件名");
    } finally {
      this.downloadBusy = false;
    }
  }
  async downloadOnce(entry, name, params, end, prefix, offset) {
    let s;
    try {
      return await new Promise((resolve, reject) => {
        let idle;
        s = {
          entry,
          name,
          deviceId: this.device?.id,
          chunks: prefix ? [...prefix.chunks] : [],
          bytes: prefix?.bytes || 0,
          offset,
          originOffset: prefix?.originOffset ?? offset,
          segment: end !== null || (offset > 0 && !prefix),
          expected:
            end !== null
              ? end - offset
              : name.toLowerCase().endsWith(".wav") &&
                  entry.duration < 946684800
                ? entry.duration * 32000 + 44
                : entry.size,
          arm: () => {
            clearTimeout(idle);
            idle = setTimeout(
              () =>
                s.finish(
                  new Error("下载空闲超过 12 秒；缓存已保留，可续传或导出"),
                ),
              12000,
            );
          },
          finish: (error) => {
            if (this.downloadSession !== s) return;
            clearTimeout(idle);
            this.downloadSession = null;
            if (error) {
              this.partial = s.bytes ? s : null;
              this.emit("partial", this.partial);
              error.received = s.bytes;
              reject(error);
            } else {
              const bytes = concat(s.chunks),
                wav = inspectWav(bytes);
              this.partial = null;
              this.emit("partial", null);
              const result = { name, bytes, wav, segment: s.segment, offset };
              this.emit("download", result);
              resolve(result);
            }
          },
        };
        this.downloadSession = s;
        this.send(2, end === null ? 2 : 12, params).then(
          () => {
            if (this.downloadSession === s) s.arm();
          },
          (e) => s.finish(e),
        );
      });
    } catch (e) {
      if (!e.ended && this.state.connected) {
        try {
          await this.request(2, 7, [], [11], 3000);
        } catch {
          this.transferUncertain = true;
          this.log("WARN", "终止传输未获确认，请重连后继续文件操作");
        }
      }
      throw e;
    }
  }
  cancelDownload() {
    this.downloadSession?.finish(new Error("已取消下载；接收缓存已保留"));
  }
  async deleteFile(entry) {
    if (this.downloadBusy || this.listSession)
      throw new Error("请先结束文件传输");
    const f = await this.request(2, 8, entry.raw, [13], 3000);
    if (f.body[0] !== 0) throw new Error("设备未确认删除成功");
    return this.getFiles();
  }
  async live(action) {
    if (action === "start") {
      if (this.state.live !== "stopped") throw new Error("实时会话已在进行中");
      const old = {
        chunks: this.liveChunks,
        packets: this.livePackets,
        bytes: this.state.bytes,
        count: this.state.packets,
      };
      this.liveChunks = [];
      this.livePackets = [];
      this.update({ live: "starting", bytes: 0, packets: 0, liveName: "" });
      try {
        await this.send(1, 0);
        if (this.state.live === "starting") this.update({ live: "waiting" });
      } catch (e) {
        this.liveChunks = old.chunks;
        this.livePackets = old.packets;
        this.update({ live: "stopped", bytes: old.bytes, packets: old.count });
        throw e;
      }
      this.log("INFO", "实时启动命令已发送，等待文件名或音频数据");
    } else {
      await this.send(
        1,
        action === "stop" ? 2 : 3,
        action === "stop" ? [] : [action === "pause" ? 1 : 0],
      );
      this.update({
        live:
          action === "stop"
            ? "stopped"
            : action === "pause"
              ? "paused"
              : "waiting",
      });
      this.log("INFO", "实时控制命令已发送，最终状态以设备通知为准");
    }
  }
  raw(type, cmd, params) {
    if (![type, cmd].every((x) => Number.isInteger(x) && x >= 0 && x <= 255))
      throw new Error("TYPE / CMD 必须为 0–255 的整数");
    return this.send(type, cmd, params);
  }
}
