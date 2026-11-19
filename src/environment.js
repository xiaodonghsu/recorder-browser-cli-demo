export function bluetoothEnvironment(scope = globalThis) {
  const win = scope.window;
  const nav = scope.navigator;
  const policy =
    scope.document?.permissionsPolicy || scope.document?.featurePolicy;
  let bluetoothAllowed = null;
  try {
    if (typeof policy?.allowsFeature === "function")
      bluetoothAllowed = policy.allowsFeature("bluetooth");
  } catch {
    /* An unavailable policy API cannot establish permission. */
  }
  return {
    origin: scope.location?.origin || "未知来源",
    secureContext:
      typeof scope.isSecureContext === "boolean" ? scope.isSecureContext : null,
    apiExposed: typeof nav?.bluetooth?.requestDevice === "function",
    embedded: win ? win.top !== win : null,
    bluetoothAllowed,
  };
}

export function bluetoothEnvironmentIssue(info = bluetoothEnvironment()) {
  if (info.secureContext === false)
    return `当前地址 ${info.origin} 不是安全上下文，浏览器无法开放 Web Bluetooth。本机请使用 http://127.0.0.1:5186/ 或 http://localhost:5186/；跨设备访问请配置受信任的 HTTPS。普通 HTTP 局域网 IP 不满足要求。`;
  if (info.bluetoothAllowed === false)
    return "当前页面的 Permissions Policy 禁止蓝牙。请在独立标签页打开，或检查服务器 Permissions-Policy 与 iframe 的 bluetooth 授权。";
  if (!info.apiExposed)
    return "当前页面未获得 Web Bluetooth API。请检查浏览器支持、启动参数和管理策略；此提示不表示蓝牙硬件故障。可在协议调试中查看浏览器环境诊断。";
  return "";
}

export async function bluetoothDiagnostics(scope = globalThis) {
  const info = bluetoothEnvironment(scope);
  info.issue = bluetoothEnvironmentIssue(info);
  info.adapterAvailable = null;
  // Read-only capability query; never opens a device chooser or requests a grant.
  if (
    info.apiExposed &&
    typeof scope.navigator.bluetooth.getAvailability === "function"
  ) {
    try {
      info.adapterAvailable = await scope.navigator.bluetooth.getAvailability();
    } catch (e) {
      info.availabilityError = `${e.name}: ${e.message}`;
    }
  }
  return info;
}
