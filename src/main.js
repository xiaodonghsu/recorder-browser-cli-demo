import "./style.css";
import { Recorder } from "./recorder.js";
import { LiveAudio, packetCapture } from "./audio.js";
import { isRecorderOpus, recorderOpusToOgg } from "./ogg-opus.js";
import { parseHex } from "./protocol.js";
import {
  bluetoothEnvironment,
  bluetoothEnvironmentIssue,
  bluetoothDiagnostics,
} from "./environment.js";

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const bytes = (n) =>
  n == null
    ? "—"
    : n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;
const duration = (s) =>
  s == null
    ? "—"
    : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const recorder = new Recorder();
let busy = false,
  files = [],
  logs = [],
  selected = -1,
  lastBytes = 0,
  rates = Array(72).fill(0),
  playbackUrl,
  toastTimer;
let currentView = "overview",
  samplePeak = 0;
let actionSequence = 0,
  clickedAction = null,
  runningAction = null;
const audio = new LiveAudio(
  (samples) => {
    samplePeak = samples.reduce((n, x) => Math.max(n, Math.abs(x)), 0);
  },
  (e) => {
    $("monitor").checked = false;
    report(e);
  },
);

document.querySelector("#app").innerHTML = `
  <aside class="sidebar">
    <a class="brand" href="#overview" aria-label="VoiceHub 首页"><span class="brand-mark">▥</span><span>voicehub<span class="brand-dot">.</span></span></a>
    <div class="workspace-label">DEVICE WORKSPACE</div>
    <nav aria-label="主导航">
      <a class="nav-item active" href="#overview" data-view="overview"><span>◫</span>设备工作台</a>
      <a class="nav-item" href="#live" data-view="live"><span>≋</span>实时音频<span class="nav-tag">LIVE</span></a>
      <a class="nav-item" href="#files" data-view="files"><span>▤</span>录音文件</a>
      <a class="nav-item" href="#debug" data-view="debug"><span>⌘</span>协议调试</a>
    </nav>
    <div class="sidebar-bottom"><div class="native-label"><span class="small-dot"></span> 浏览器直连 BLE</div><p>无需 Python · 无需网关<br>音频数据保留在当前浏览器</p><div class="sidebar-version">VOICEHUB LAB / V1.0</div></div>
  </aside>
  <main>
    <header class="topbar"><span>工作空间 <span class="slash">/</span> <b id="breadcrumb">设备工作台</b></span><div class="topbar-right"><span id="browserBadge" class="pill">检测浏览器能力</span><button id="settingsOpen" class="icon-button" aria-label="协议设置">⚙</button></div></header>
    <div class="page">
      <div class="page-heading"><div><div class="eyebrow">BLUETOOTH RECORDING LAB</div><h1 id="pageTitle">让录音，直接连接浏览器<span>.</span></h1><p id="pageSubtitle">连接你的录音卡，管理录音与实时音频。所有操作，从这里开始。</p></div><span class="local-badge"><i></i> 本地工作空间</span></div>
      <div id="compatNotice" class="notice" hidden></div>
      <section id="section-overview" class="view">
        <div class="connection-card"><div class="device-illustration" aria-hidden="true"><div class="recorder-card"><span>voicehub</span><div class="device-led"></div><div class="device-lines"></div><div class="device-button"></div><small>VOICE RECORDER</small></div><div class="device-ring ring-one"></div><div class="device-ring ring-two"></div></div><div class="connection-copy"><div id="connectionBadge" class="status-label"><i></i> 等待连接设备</div><h2 id="deviceName">你的录音卡，已准备好？</h2><p id="deviceDescription">打开录音卡电源并保持在附近，<br>通过浏览器安全授权，即可开始连接。</p><div class="connection-actions"><button id="connect" class="button primary">⌁ &nbsp; 连接蓝牙录音卡</button><button id="disconnect" class="button" disabled>断开连接</button></div><label class="check-line"><input id="compatScan" type="checkbox">兼容扫描（显示所有蓝牙设备）</label></div><span class="card-index">01 / CONNECT</span></div>
        <section id="authPanel" class="panel auth-panel"><div class="panel-heading"><div><span class="eyebrow">02 / DEVICE AUTHORIZATION</span><h2>设备授权</h2></div><span id="authStatus" class="tag">未授权</span></div><p class="muted">连接录音卡后先完成授权，再查询设备信息或控制录音。</p><label class="field-label" for="authKey">AUTHKEY</label><div class="input-action"><input id="authKey" type="password" autocomplete="off" spellcheck="false" value="0xae4b1e65f7ba1282d2060876d324253c95e9475307b4e9e14f9a708dcc54b250" placeholder="64 位十六进制密钥，可带 0x 前缀"><button id="authenticate" class="button primary" disabled>授权并获取设备信息</button></div><p class="helper">默认授权码已预填，可按设备修改；密钥不会写入日志。收到设备授权成功应答后，自动获取设备信息。</p><div class="divider"></div><div class="control-row"><span id="authHint">请先连接录音卡</span><button id="refresh" class="button" disabled>↻ 读取设备信息</button></div></section>
        <div class="metrics" aria-label="设备信息"><article class="metric"><div class="metric-label">设备 SN</div><div class="metric-value mono" id="deviceSn">—</div><div class="metric-foot" id="snHint">授权后读取</div></article><article class="metric"><div class="metric-label">设备电量 <span>◷</span></div><div class="metric-value" id="battery">—<small>%</small></div><div class="metric-foot"><div class="meter"><i id="batteryBar"></i></div><span id="batteryHint">连接后读取</span></div></article><article class="metric"><div class="metric-label">剩余存储 <span>▤</span></div><div class="metric-value" id="capacity">—<small>GB</small></div><div class="metric-foot" id="capacityHint">等待获取存储信息</div></article><article class="metric"><div class="metric-label">固件版本 <span>⌘</span></div><div class="metric-value mono" id="firmware">—</div><div class="metric-foot">BLE GATT · AE20</div></article><article class="metric"><div class="metric-label">录音状态 <span>◉</span></div><div class="metric-value" id="recordState">未连接</div><div class="metric-foot" id="recordTime">等待设备状态</div></article></div>
        <section class="panel"><div class="panel-heading"><div><span class="eyebrow">DEVICE CONTROL</span><h2>录音控制</h2></div><span class="tag">保存至录音卡</span></div><p class="muted">远程控制设备录制，结束后保存到设备存储。</p><div class="record-controls"><button class="button record" data-record="start" disabled><span class="record-dot"></span>开始录音</button><button class="button" data-record="pause" disabled>Ⅱ 暂停</button><button class="button" data-record="resume" disabled>▷ 继续</button><button class="button" data-record="save" disabled>□ 保存录音</button></div><div class="divider"></div><div class="control-row"><label for="gain">麦克风增益</label><div><select id="gain"><option value="1">低增益</option><option value="2" selected>中增益</option><option value="3">高增益</option></select><button id="setGain" class="button compact" disabled>应用</button></div></div><div class="control-row"><span>设备时间</span><button id="sync" class="text-button" disabled>同步当前时间 ↗</button></div></section>
      </section>
      <section id="section-live" class="view" hidden><section class="panel live-panel"><div class="panel-heading"><div><span class="eyebrow">LIVE AUDIO STREAM</span><h2>实时音频接收</h2></div><span id="liveStatus" class="status-label"><i></i> 未开始</span></div><p class="muted">直接接收录音卡的音频载荷。实时推流与设备存储录音分别控制。</p><div class="stream-stats"><div><small>接收数据</small><strong id="liveBytes">0 B</strong></div><div><small>音频载荷包</small><strong id="livePackets">0</strong></div><div><small>当前传输速率</small><strong id="liveRate">0 B/s</strong></div><div><small>CRC 错误</small><strong id="crcErrors">0</strong></div></div><div class="chart-wrap"><div class="chart-label"><span>实时传输速率 / 最近 72 秒</span><span id="chartScale">0 B/s</span></div><canvas id="streamChart" height="170" aria-label="实时音频数据传输速率图"></canvas><div class="chart-axis"><span>−72s</span><span>−36s</span><span>现在</span></div></div><p class="filename">会话文件 <span id="liveName">尚未接收设备文件名</span></p><div class="actions"><button class="button primary" id="liveStart" disabled>▷ 开始推流</button><button class="button" id="livePause" disabled>Ⅱ 暂停</button><button class="button" id="liveResume" disabled>▷ 继续</button><button class="button" id="liveStop" disabled>□ 停止推流</button><span class="action-spacer"></span><button class="button" id="exportLive" disabled>↓ 原始码流</button><button class="button" id="exportCapture" disabled>↓ 保留包边界</button></div><div class="divider"></div><div class="monitor-row"><label class="check-line"><input type="checkbox" id="monitor">实验性 Opus 实时试听</label><span id="pcmLevel" class="mono muted">PCM —</span><button class="text-button" id="exportWav" disabled>导出已解码 WAV ↗</button></div><p class="helper">仅当每个 1-1 载荷恰好是一个完整的标准 Opus 包时启用；私有包头、跨包分片或其他编码需先适配。解码失败不影响原始数据接收。</p></section></section>
      <section id="section-files" class="view" hidden><section class="panel"><div class="panel-heading"><div><span class="eyebrow">RECORDING LIBRARY</span><h2>设备录音文件 <span id="fileCount" class="count">0</span></h2></div><button id="listFiles" class="button" disabled>↻ 获取文件列表</button></div><div class="table-wrap"><table><thead><tr><th>录音名称</th><th>时长 / 时间</th><th>设备大小</th><th>操作</th></tr></thead><tbody id="fileRows"></tbody></table></div><div id="filesEmpty" class="empty"><span>▤</span><h3>录音，井然有序</h3><p>连接设备后获取文件列表，在这里下载和试听录音。</p></div></section>
      <section class="panel transfer-panel"><div class="panel-heading"><div><span class="eyebrow">FILE TRANSFER</span><h2>下载与试听</h2></div><span class="tag">全部在浏览器内处理</span></div><p class="muted" id="selectedFile">点击上方下载即开始接收录音；也可在下方输入文件名和偏移后下载。</p><div class="download-fields"><label>请求文件名<input id="downloadName" placeholder="留空：自动尝试 OPUS → WAV → 原始名称"></label><label>开始偏移 / Byte<input id="offset" type="number" min="0" max="4294967295" value="0"></label><label>结束偏移 / Byte<input id="endOffset" type="number" min="1" placeholder="留空：下载到结束"></label></div><div class="actions"><button class="button primary" id="download" disabled>↓ 下载文件</button><button class="button" id="cancelDownload" disabled>取消传输</button><button class="button" id="resumeDownload" disabled>续传缓存文件</button><button class="text-button" id="exportPartial" disabled>导出未完成片段 ↗</button></div><div class="transfer-status"><span id="downloadStatus">等待开始传输</span><span id="downloadProgress"></span></div><progress id="progress" value="0" max="1"></progress><p class="helper">设备压缩大小与 WAV 导出大小可能不同，进度为估算。续传使用本页保留的同一文件前缀；自定义偏移与分段导出为片段。刷新页面将清除缓存。</p><div id="playback" hidden><div class="divider"></div><p id="playbackInfo"></p><audio id="player" controls></audio><a id="saveFile" class="button" download>↓ 保存文件</a></div></section></section>
      <section id="section-debug" class="view" hidden><section class="panel"><div class="panel-heading"><div><span class="eyebrow">PROTOCOL INSPECTOR</span><h2>原始命令</h2></div><span class="tag">CRC 自动封包</span></div><div class="raw-fields"><label>TYPE<input type="number" id="rawType" min="0" max="255" value="0"></label><label>CMD<input type="number" id="rawCmd" min="0" max="255" value="3"></label><label>PARAMS / HEX<input id="rawParams" placeholder="例如：01 0A FF" spellcheck="false"></label><button id="sendRaw" class="button primary" disabled>发送命令 ↗</button></div><p class="helper">帧格式 5A · SEQ · CRC(LE) · LEN(LE) · TYPE · CMD · PARAMS。仅 TYPE 的 ACK 不作为业务成功应答。原始命令可能改变设备数据，请核对协议。</p></section></section>
      <footer><span><i class="small-dot"></i> BLE + GATT 私有协议 · 纯浏览器运行</span><span>VOICEHUB / BROWSER LAB</span></footer>
    </div>
  </main>
  <aside class="panel log-panel" aria-label="持续会话日志"><div class="panel-heading"><div class="log-heading"><span class="terminal-icon">›_</span><h2>会话日志</h2><span id="logCount" class="count">0</span><span class="log-persistent">持续记录</span></div><div class="log-actions"><label class="check-line"><input id="onlyErrors" type="checkbox">仅警告 / 错误</label><button id="exportLogs" class="text-button">导出</button><button id="clearLogs" class="text-button">清空</button></div></div><div id="logs" class="logs" role="log" aria-label="设备通信日志"></div><div class="log-footer">ACTION 操作 · TX 发送 · RX 应答 · OK / ERR 结果</div></aside>
  <div id="toast" role="status" hidden></div>
  <dialog id="settings"><div class="panel-heading"><h2>协议兼容设置</h2><button id="settingsClose" class="icon-button" aria-label="关闭设置">×</button></div><p class="muted">参考项目文档与实现存在长度差异，请按目标固件选择。</p><label class="field-label">文件列表条目长度<select id="listLayout"><option value="auto">自动检测（28B / 33B）</option><option value="28">28B：20B 文件名</option><option value="33">33B：25B 文件名</option></select></label><label class="field-label">导入请求文件名长度<select id="nameLength"><option value="24">24B（36B 请求，早期真机示例）</option><option value="29" selected>29B（41B 请求，参考 Python 当前代码）</option><option value="25">25B（文档表格版本）</option></select></label><label class="check-line"><input id="legacyRecord" type="checkbox">兼容 3-0 旧版录音控制应答</label><p class="helper">不会截断超长文件名。Web Bluetooth 不提供手动 MTU 协商；整帧写入失败时请重连或检查系统蓝牙。设置仅作用于后续操作。</p><button id="settingsSave" class="button primary">应用设置</button></dialog>
  <dialog id="confirmDialog"><h2 id="confirmTitle">确认操作</h2><p id="confirmText"></p><div class="actions"><button id="confirmCancel" class="button">取消</button><button id="confirmOk" class="button danger">确认</button></div></dialog>
`;

function toast(message, error = false) {
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5500);
}
function report(e, operation = null) {
  recorder.log(
    "ERR",
    operation
      ? `#${operation.id} ${operation.label}失败：${e.message}`
      : e.message,
  );
  toast(e.message, true);
}
async function run(task) {
  const operation = clickedAction;
  if (busy) {
    recorder.log(
      "WARN",
      `${operation ? `#${operation.id} ` : ""}当前操作尚未结束，本次请求未执行`,
    );
    toast("当前操作尚未结束，请稍候");
    return;
  }
  busy = true;
  runningAction = operation;
  renderState();
  try {
    await task();
    if (operation && !operation.cancelled)
      recorder.log(
        "INFO",
        `#${operation.id} ${operation.label}：处理结束（设备执行结果以应答为准）`,
      );
  } catch (e) {
    report(e, operation);
  } finally {
    runningAction = null;
    busy = false;
    renderState();
  }
}
function save(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]/g, "_");
  a.click();
  recorder.log("INFO", `已发起浏览器下载：${a.download}`);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function confirmAction(title, message) {
  const operation = runningAction;
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = message;
  $("confirmDialog").showModal();
  return new Promise((resolve) => {
    const finish = (answer) => {
      if (!answer && operation) operation.cancelled = true;
      recorder.log(
        "INFO",
        `${operation ? `#${operation.id} ` : ""}${answer ? "已确认" : "已取消"}：${title}`,
      );
      $("confirmDialog").close();
      $("confirmOk").onclick = null;
      $("confirmCancel").onclick = null;
      $("confirmDialog").oncancel = null;
      resolve(answer);
    };
    $("confirmOk").onclick = () => finish(true);
    $("confirmCancel").onclick = () => finish(false);
    $("confirmDialog").oncancel = (e) => {
      e.preventDefault();
      finish(false);
    };
  });
}
function view(name) {
  if (!["overview", "live", "files", "debug"].includes(name)) name = "overview";
  currentView = name;
  document
    .querySelectorAll(".view")
    .forEach((el) => (el.hidden = el.id !== `section-${name}`));
  document
    .querySelectorAll("[data-view]")
    .forEach((el) => el.classList.toggle("active", el.dataset.view === name));
  const copy = {
    overview: [
      "设备工作台",
      "让录音，直接连接浏览器",
      "连接你的录音卡，管理录音与实时音频。所有操作，从这里开始。",
    ],
    live: [
      "实时音频",
      "声音，此刻传送",
      "通过 BLE 通知接收音频载荷，观察传输状态，保存每一个数据包。",
    ],
    files: [
      "录音文件",
      "每一段声音，都有归处",
      "读取设备录音，直接下载到浏览器，校验并试听标准 WAV 文件。",
    ],
    debug: [
      "协议调试",
      "深入每一次通信",
      "查看协议应答与事件，发送自定义命令，排查固件兼容问题。",
    ],
  }[name];
  $("breadcrumb").textContent = copy[0];
  $("pageTitle").innerHTML = `${copy[1]}<span>.</span>`;
  $("pageSubtitle").textContent = copy[2];
  if (name === "live") drawChart();
}
window.addEventListener("hashchange", () => view(location.hash.slice(1)));
view(location.hash.slice(1));

function renderState() {
  const s = recorder.state,
    connectedReady = s.connected && !busy,
    ready = connectedReady && s.authenticated;
  $("connect").disabled = busy || s.connected;
  $("disconnect").disabled = !s.connected && !recorder.connecting;
  for (const id of [
    "refresh",
    "sync",
    "setGain",
    "listFiles",
    "download",
    "sendRaw",
  ])
    $(id).disabled = !ready;
  $("authenticate").disabled = !connectedReady;
  // Keep the low-level debugger available for authorization troubleshooting.
  $("sendRaw").disabled = !connectedReady;
  $("download").disabled ||=
    !files[selected] && !$("downloadName").value.trim();
  document
    .querySelectorAll("[data-file], [data-delete]")
    .forEach((button) => (button.disabled = !ready));
  document
    .querySelectorAll("[data-record]")
    .forEach((b) => (b.disabled = !ready));
  $("connectionBadge").innerHTML =
    `<i></i> ${s.connected ? "设备已连接" : "等待连接设备"}`;
  $("connectionBadge").classList.toggle("online", s.connected);
  $("deviceName").textContent = s.connected ? s.name : "你的录音卡，已准备好？";
  $("deviceDescription").textContent = s.connected
    ? `AE22 通知已就绪 · 浏览器原生蓝牙连接\n${s.id}`
    : "打开录音卡电源并保持在附近，\n通过浏览器安全授权，即可开始连接。";
  $("battery").innerHTML =
    s.battery === 110 ? "充电中" : `${s.battery ?? "—"}<small>%</small>`;
  $("batteryBar").style.width = `${Math.min(s.battery || 0, 100)}%`;
  $("batteryHint").textContent =
    s.battery == null
      ? "等待设备电量通知"
      : s.battery === 110
        ? "正在充电"
        : "设备报告电量";
  $("capacity").innerHTML =
    `${s.capacity ? (s.capacity.free / 1073741824).toFixed(1) : "—"}<small>GB</small>`;
  $("capacityHint").textContent = s.capacity
    ? `总容量 ${(s.capacity.total / 1073741824).toFixed(1)} GB`
    : "等待获取存储信息";
  $("deviceSn").textContent = s.sn || (s.snStatus === "unavailable" ? "未知" : "—");
  $("snHint").textContent = {
    idle: "授权后读取",
    reading: "正在读取…",
    ready: "设备序列号",
    unavailable: "未提供或读取失败",
  }[s.snStatus];
  $("firmware").textContent = s.version || "—";
  $("recordState").textContent = !s.connected
    ? "未连接"
    : { 1: "录音中", 2: "未录音", 3: "已暂停" }[s.recording] || "待查询";
  $("recordTime").textContent =
    s.duration == null
      ? "等待设备状态"
      : `${duration(s.duration)} · ${bytes(s.recordSize)}`;
  $("authStatus").textContent = s.authenticated ? "已授权" : "未授权";
  $("authStatus").classList.toggle("green", s.authenticated);
  $("authHint").textContent = !s.connected
    ? "请先连接录音卡"
    : s.authenticated
      ? "已授权，可获取设备信息"
      : "等待授权；设备信息查询尚未启用";
  if (s.gain) $("gain").value = String(s.gain);
  $("liveStart").disabled = !ready || s.live !== "stopped";
  for (const id of ["livePause", "liveResume", "liveStop"])
    $(id).disabled = !ready || s.live === "stopped";
  $("liveStatus").innerHTML =
    `<i></i> ${{ stopped: "已停止", starting: "正在启动", waiting: "等待设备数据", streaming: "接收中", paused: "已暂停", unknown: "未知状态" }[s.live] || s.live}`;
  $("liveStatus").classList.toggle("online", s.live === "streaming");
  $("liveName").textContent = s.liveName || "尚未接收设备文件名";
  $("crcErrors").textContent = s.crcErrors;
  $("cancelDownload").disabled = !recorder.downloadSession;
  $("resumeDownload").disabled =
    !ready ||
    !recorder.partial ||
    recorder.partial.segment ||
    recorder.partial.deviceId !== recorder.device?.id;
  $("exportPartial").disabled = !recorder.partial;
  renderLive();
}
function renderLive() {
  $("liveBytes").textContent = bytes(recorder.state.bytes);
  $("livePackets").textContent = recorder.state.packets.toLocaleString();
  $("exportLive").disabled = $("exportCapture").disabled =
    !recorder.state.bytes;
  $("exportWav").disabled = !audio.samples;
  $("pcmLevel").textContent = audio.enabled
    ? `PCM 峰值 ${(samplePeak * 100).toFixed(0)}%`
    : "PCM —";
}
function renderFiles() {
  $("fileCount").textContent = files.length;
  $("filesEmpty").hidden = !!files.length;
  $("fileRows").innerHTML = files
    .map(
      (f, i) =>
        `<tr class="${selected === i ? "selected" : ""}"><td><span class="file-icon">♫</span><span class="mono">${esc(f.name)}</span></td><td>${f.duration > 946684800 && f.duration < 4102444800 ? esc(new Date(f.duration * 1000).toLocaleString()) : duration(f.duration)}</td><td>${bytes(f.size)}</td><td><button class="text-button" data-file="${i}">下载 ↗</button><button class="text-button delete" data-delete="${i}" aria-label="删除 ${esc(f.name)}">删除</button></td></tr>`,
    )
    .join("");
}
function renderLogs() {
  const filtered = $("onlyErrors").checked
    ? logs.filter((x) => ["WARN", "ERR"].includes(x.level))
    : logs;
  const atBottom =
    $("logs").scrollHeight - $("logs").scrollTop - $("logs").clientHeight < 50;
  $("logs").innerHTML = filtered.length
    ? filtered
        .slice(-200)
        .map(
          (x) =>
            `<div class="log-line"><time>${new Date(x.time).toLocaleTimeString("zh-CN", { hour12: false })}</time><b class="level-${x.level}">${x.level}</b><span>${esc(x.message)}</span></div>`,
        )
        .join("")
    : '<div class="log-placeholder">等待设备通信。连接后，命令与事件将在这里显示。</div>';
  $("logCount").textContent = logs.length;
  if (atBottom) $("logs").scrollTop = $("logs").scrollHeight;
}
let logScheduled = false;
recorder.addEventListener("log", ({ detail }) => {
  logs.push(detail);
  if (logs.length > 2000) logs.shift();
  if (!logScheduled) {
    logScheduled = true;
    setTimeout(() => {
      logScheduled = false;
      renderLogs();
    }, 80);
  }
});
recorder.addEventListener("state", () => {
  if (!recorder.state.connected) {
    audio.stop();
    $("monitor").checked = false;
  }
  renderState();
});
recorder.addEventListener("audio", ({ detail }) => audio.push(detail));
recorder.addEventListener("files", ({ detail }) => {
  files = detail;
  selected = -1;
  renderFiles();
  renderState();
});
recorder.addEventListener("partial", () => renderState());
recorder.addEventListener("progress", ({ detail: p }) => {
  $("downloadStatus").textContent = `接收中 · ${p.name}`;
  $("downloadProgress").textContent =
    `${bytes(p.bytes)} / 预计 ${bytes(p.expected)}`;
  if (p.expected > 0) {
    $("progress").max = p.expected;
    $("progress").value = Math.min(p.bytes, p.expected);
  } else $("progress").removeAttribute("value");
  $("cancelDownload").disabled = false;
});
recorder.addEventListener("download", ({ detail: result }) => {
  if (playbackUrl) URL.revokeObjectURL(playbackUrl);
  const oldRawLink = $("saveRawFile");
  if (oldRawLink) {
    URL.revokeObjectURL(oldRawLink.href);
    oldRawLink.remove();
  }
  const validWav = result.wav.valid && !result.segment;
  const wrappedOpus = !result.segment && !result.wav.isWav && isRecorderOpus(result.bytes);
  const playable = validWav || wrappedOpus;
  playbackUrl = URL.createObjectURL(
    new Blob([wrappedOpus ? recorderOpusToOgg(result.bytes) : result.bytes], {
      type: validWav ? "audio/wav" : wrappedOpus ? "audio/ogg; codecs=opus" : "application/octet-stream",
    }),
  );
  const suffix = result.segment
    ? ".part.bin"
    : result.wav.isWav && !result.wav.valid
      ? ".invalid.wav.bin"
      : wrappedOpus ? ".ogg.opus" : "";
  $("saveFile").href = playbackUrl;
  const safeName = result.name.replace(/[\\/:*?"<>|]/g, "_");
  $("saveFile").download = (wrappedOpus ? safeName.replace(/\.opus$/i, "") : safeName) + suffix;
  if (wrappedOpus) {
    const link = document.createElement("a");
    link.id = "saveRawFile";
    link.className = "button";
    link.textContent = "↓ 保存原始裸流";
    link.download = `${safeName}.bin`;
    link.href = URL.createObjectURL(new Blob([result.bytes]));
    $("saveFile").after(link);
  }
  $("playback").hidden = false;
  $("player").hidden = !playable;
  if (playable) $("player").src = playbackUrl;
  else {
    $("player").removeAttribute("src");
    $("player").load();
  }
  const info = result.segment
    ? "分段数据，请保存后按偏移重组"
    : validWav
      ? `WAV 校验通过 · ${result.wav.sampleRate} Hz / ${result.wav.bits} bit / ${result.wav.channels} 声道`
      : wrappedOpus
        ? `已将 40 字节/包 Opus 裸流封装为 Ogg Opus · ${(result.bytes.length / 40 * 0.02).toFixed(2)} 秒 / 单声道`
      : result.wav.isWav
        ? "WAV 长度或结构校验失败，已保留原始数据供排查"
        : "原始文件（未识别为标准 WAV）";
  $("playbackInfo").textContent =
    `${result.name} · ${bytes(result.bytes.length)} · ${info}`;
  $("downloadStatus").textContent = "传输完成";
  $("downloadProgress").textContent = bytes(result.bytes.length);
  $("progress").max = 1;
  $("progress").value = 1;
  recorder.log(playable ? "OK" : "WARN", info);
  toast("文件已接收，可试听或保存到本地");
});

$("connect").onclick = () =>
  run(async () => {
    recorder.bluetooth = navigator.bluetooth;
    await recorder.connect($("compatScan").checked);
    recorder.log(
      "INFO",
      "连接已建立，请先完成设备授权；授权前仅接收设备通知，不查询设备信息",
    );
  });
$("disconnect").onclick = () => recorder.disconnect();
$("refresh").onclick = () => run(() => recorder.refresh());
$("sync").onclick = () =>
  run(async () => {
    await recorder.syncClock();
    toast("设备时间同步命令已发送");
  });
$("setGain").onclick = () => run(() => recorder.gain(Number($("gain").value)));
$("authenticate").onclick = () =>
  run(async () => {
    const value = $("authKey").value;
    await recorder.authenticate(value);
    toast("设备授权通过，正在获取设备信息");
    await recorder.refresh();
  });
document
  .querySelectorAll("[data-record]")
  .forEach(
    (b) => (b.onclick = () => run(() => recorder.record(b.dataset.record))),
  );
$("listFiles").onclick = () => run(() => recorder.getFiles());
$("fileRows").onclick = (e) => {
  const choose = e.target.closest("[data-file]"),
    remove = e.target.closest("[data-delete]");
  if (choose && !choose.disabled && !busy && recorder.state.connected) {
    selected = Number(choose.dataset.file);
    $("selectedFile").textContent = `已选择：${files[selected].name}`;
    $("downloadName").value = "";
    $("offset").value = "0";
    $("endOffset").value = "";
    renderFiles();
    renderState();
    startDownload();
  }
  if (remove)
    run(async () => {
      const f = files[Number(remove.dataset.delete)];
      if (
        await confirmAction(
          "删除设备录音？",
          `将永久删除录音卡上的 ${f.name}，无法恢复。`,
        )
      )
        await recorder.deleteFile(f);
    });
};
$("downloadName").oninput = renderState;
function startDownload() {
  return run(async () => {
    const name = $("downloadName").value.trim(),
      entry = files[selected] || { name, size: 0, duration: 0 };
    $("downloadStatus").textContent = "正在请求设备文件";
    $("downloadProgress").textContent = "";
    $("progress").removeAttribute("value");
    try {
      await recorder.download(entry, {
        name: name || undefined,
        offset: Number($("offset").value),
        end: $("endOffset").value === "" ? null : Number($("endOffset").value),
      });
    } catch (e) {
      $("downloadStatus").textContent = e.message;
      throw e;
    }
  });
}
$("download").onclick = startDownload;
$("cancelDownload").onclick = () => recorder.cancelDownload();
$("resumeDownload").onclick = () =>
  run(async () => {
    try {
      await recorder.download(recorder.partial.entry, { resume: true });
    } catch (e) {
      $("downloadStatus").textContent = e.message;
      throw e;
    }
  });
$("exportPartial").onclick = () => {
  const p = recorder.partial;
  if (p)
    save(new Blob(p.chunks), `${p.name}.offset-${p.originOffset}.partial.bin`);
};
for (const [id, action] of [
  ["liveStart", "start"],
  ["livePause", "pause"],
  ["liveResume", "resume"],
  ["liveStop", "stop"],
])
  $(id).onclick = () =>
    run(async () => {
      if (action === "start") {
        if (
          recorder.state.bytes &&
          !(await confirmAction(
            "开始新音频会话？",
            "新的会话会清除上一会话的音频缓存。请先导出需要保留的数据。",
          ))
        )
          return;
        const monitor = $("monitor").checked;
        audio.reset();
        rates.fill(0);
        lastBytes = 0;
        if (monitor) {
          try {
            await audio.enable();
          } catch (e) {
            $("monitor").checked = false;
            report(e);
          }
        }
      }
      await recorder.live(action);
      if (action === "stop") {
        audio.stop();
        $("monitor").checked = false;
      }
    });
$("monitor").onchange = async () => {
  if ($("monitor").checked) {
    try {
      await audio.enable();
      recorder.log(
        "WARN",
        "已开启实验性试听：假设每个音频载荷为一个标准 Opus 包",
      );
    } catch (e) {
      $("monitor").checked = false;
      report(e);
    }
  } else audio.stop();
};
$("exportLive").onclick = () =>
  save(new Blob(recorder.liveChunks), `live-${stamp()}.opus.bin`);
$("exportCapture").onclick = () =>
  save(
    packetCapture(
      recorder.liveChunks,
      recorder.livePackets,
      recorder.state.liveName,
    ),
    `live-${stamp()}.vhstream`,
  );
$("exportWav").onclick = () => {
  try {
    save(
      new Blob([audio.wav()], { type: "audio/wav" }),
      `decoded-${stamp()}.wav`,
    );
  } catch (e) {
    report(e);
  }
};
$("sendRaw").onclick = () =>
  run(async () => {
    const type = Number($("rawType").value),
      cmd = Number($("rawCmd").value),
      params = parseHex($("rawParams").value);
    if (
      !(await confirmAction(
        "发送原始命令？",
        `将向设备发送 TYPE=${type}, CMD=${cmd}, 参数 ${params.length} 字节。请确认其作用，命令可能修改或删除设备数据。`,
      ))
    )
      return;
    // Never leave credentials in a plain-text debug field.
    if (type === 0 && [50, 52].includes(cmd)) $("rawParams").value = "";
    await recorder.raw(type, cmd, params);
  });
$("clearLogs").onclick = () => {
  logs = [];
  renderLogs();
  recorder.log("INFO", "会话日志已清空");
};
$("onlyErrors").onchange = renderLogs;
$("exportLogs").onclick = () =>
  save(
    new Blob(
      [logs.map((x) => `${x.time} [${x.level}] ${x.message}`).join("\n")],
      { type: "text/plain;charset=utf-8" },
    ),
    `voicehub-${stamp()}.log`,
  );
$("settingsOpen").onclick = () => $("settings").showModal();
$("settingsClose").onclick = () => $("settings").close();
$("settingsSave").onclick = () => {
  recorder.settings = {
    nameLength: Number($("nameLength").value),
    listLayout: $("listLayout").value,
    legacyRecord: $("legacyRecord").checked,
  };
  $("settings").close();
  recorder.log(
    "INFO",
    `协议设置：文件名 ${recorder.settings.nameLength}B，列表 ${recorder.settings.listLayout}，旧版录音应答 ${recorder.settings.legacyRecord}`,
  );
  toast("协议设置已应用");
};
function drawChart() {
  const canvas = $("streamChart"),
    rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const scale = devicePixelRatio || 1;
  canvas.width = rect.width * scale;
  canvas.height = 170 * scale;
  const c = canvas.getContext("2d");
  c.scale(scale, scale);
  const w = rect.width,
    h = 170,
    max = Math.max(256, ...rates) * 1.2;
  c.strokeStyle = "#e8ede8";
  c.lineWidth = 1;
  for (let y = 10; y < h; y += 38) {
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(w, y);
    c.stroke();
  }
  const points = rates.map((n, i) => [
    (i / (rates.length - 1)) * w,
    h - 8 - (n / max) * (h - 20),
  ]);
  c.beginPath();
  c.moveTo(0, h);
  points.forEach(([x, y]) => c.lineTo(x, y));
  c.lineTo(w, h);
  c.closePath();
  const gradient = c.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, "#c8e9ae99");
  gradient.addColorStop(1, "#c8e9ae08");
  c.fillStyle = gradient;
  c.fill();
  c.beginPath();
  points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.strokeStyle = "#6c9b46";
  c.lineWidth = 2;
  c.stroke();
  $("chartScale").textContent = `${bytes(Math.round(max))}/s`;
}
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now(),
    rate = Math.max(
      0,
      Math.round(
        ((recorder.state.bytes - lastBytes) * 1000) / (now - lastTick),
      ),
    );
  lastTick = now;
  lastBytes = recorder.state.bytes;
  rates.push(rate);
  rates.shift();
  $("liveRate").textContent = `${bytes(rate)}/s`;
  renderLive();
  if (currentView === "live") drawChart();
}, 1000);
window.addEventListener("resize", drawChart);
window.addEventListener("beforeunload", (e) => {
  if (
    recorder.downloadSession ||
    recorder.state.live !== "stopped" ||
    recorder.state.bytes ||
    recorder.partial
  ) {
    e.preventDefault();
    e.returnValue = "";
  }
});
const environment = bluetoothEnvironment();
const environmentIssue = bluetoothEnvironmentIssue(environment);
const supported = !environmentIssue;
$("browserBadge").textContent = supported
  ? "Web Bluetooth 就绪"
  : "Web Bluetooth 不可用";
$("browserBadge").classList.toggle("supported", supported);
if (!supported) {
  $("compatNotice").hidden = false;
  $("compatNotice").textContent =
    environmentIssue;
}
const diagnosticPanel = document.createElement("section");
diagnosticPanel.className = "panel";
diagnosticPanel.innerHTML = `<div class="panel-heading"><h2>浏览器环境诊断</h2><button id="browserDiagnostics" class="button">检测环境</button></div><p class="muted">检查访问来源、安全上下文、API 与适配器可用性。不会扫描或连接设备。</p><pre id="diagnosticResult" class="diagnostic-result"></pre>`;
$("section-debug").prepend(diagnosticPanel);
$("diagnosticResult").textContent = JSON.stringify(environment, null, 2);
$("browserDiagnostics").onclick = async () => {
  $("browserDiagnostics").disabled = true;
  try {
    const result = await bluetoothDiagnostics();
    $("diagnosticResult").textContent = JSON.stringify(result, null, 2);
    recorder.log(
      result.issue ? "WARN" : "INFO",
      `环境诊断：安全上下文=${result.secureContext}，蓝牙 API=${result.apiExposed}，适配器可用=${result.adapterAvailable}${result.issue ? `；${result.issue}` : ""}`,
    );
  } finally {
    $("browserDiagnostics").disabled = false;
  }
};
// Capture before click handlers so ACTION always precedes its TX/RX/results.
// Only record action labels, never password or raw command input contents.
document.addEventListener(
  "click",
  (event) => {
    const button = event.target.closest(
      "button, a[data-view], a.brand, #saveFile",
    );
    if (!button || button.disabled) return;
    const labels = {
      connect: "连接蓝牙录音卡",
      disconnect: "断开蓝牙连接",
      refresh: "读取设备信息",
      sync: "同步设备时间",
      setGain: "设置麦克风增益",
      authenticate: "AuthKey 鉴权",
      listFiles: "获取设备文件列表",
      download: "下载设备文件",
      cancelDownload: "取消文件传输",
      resumeDownload: "续传缓存文件",
      exportPartial: "导出未完成片段",
      saveFile: "保存接收文件",
      liveStart: "开始实时推流",
      livePause: "暂停实时推流",
      liveResume: "继续实时推流",
      liveStop: "停止实时推流",
      exportLive: "导出原始码流",
      exportCapture: "导出音频包捕获",
      exportWav: "导出解码 WAV",
      sendRaw: "发送原始协议命令",
      clearLogs: "清空会话日志",
      exportLogs: "导出会话日志",
      settingsOpen: "打开协议设置",
      settingsClose: "关闭协议设置",
      settingsSave: "应用协议设置",
      confirmOk: "确认操作",
      confirmCancel: "取消操作",
      browserDiagnostics: "检测浏览器环境",
    };
    let label =
      labels[button.id] ||
      button.getAttribute("aria-label") ||
      button.textContent.trim();
    if (button.dataset.view)
      label = `切换菜单：${{ overview: "设备工作台", live: "实时音频", files: "录音文件", debug: "协议调试" }[button.dataset.view]}`;
    if (button.dataset.record)
      label = `设备录音：${{ start: "开始", pause: "暂停", resume: "继续", save: "保存" }[button.dataset.record]}`;
    if (button.dataset.file !== undefined)
      label = `下载设备文件：${files[Number(button.dataset.file)]?.name || "未知文件"}`;
    if (button.dataset.delete !== undefined)
      label = `删除设备文件：${files[Number(button.dataset.delete)]?.name || "未知文件"}`;
    const operation = { id: String(++actionSequence).padStart(4, "0"), label };
    clickedAction = operation;
    recorder.log("ACTION", `#${operation.id} ${label}`);
    setTimeout(() => {
      if (clickedAction === operation) clickedAction = null;
    }, 0);
  },
  true,
);
document.addEventListener(
  "change",
  (event) => {
    const input = event.target;
    const checkLabels = {
      compatScan: "兼容扫描",
      monitor: "Opus 实时试听",
      onlyErrors: "日志仅显示警告 / 错误",
      legacyRecord: "旧版录音控制应答",
    };
    const selectLabels = {
      gain: "麦克风增益",
      listLayout: "文件列表条目长度",
      nameLength: "导入文件名长度",
    };
    if (checkLabels[input.id])
      recorder.log(
        "ACTION",
        `${checkLabels[input.id]}：${input.checked ? "开启" : "关闭"}`,
      );
    if (selectLabels[input.id])
      recorder.log(
        "ACTION",
        `${selectLabels[input.id]}：${input.selectedOptions[0].textContent}`,
      );
  },
  true,
);
$("player").addEventListener("play", () =>
  recorder.log("ACTION", "开始试听已下载音频"),
);
$("player").addEventListener("pause", () =>
  recorder.log("ACTION", "暂停试听已下载音频"),
);
$("player").addEventListener("ended", () =>
  recorder.log("INFO", "已下载音频试听结束"),
);
recorder.log(
  "INFO",
  "工作空间已就绪。点击连接，授权浏览器访问附近的 BLE 录音卡。",
);
renderFiles();
renderLogs();
renderState();
