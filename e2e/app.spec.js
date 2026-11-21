import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// Inject the test device through the native Bluetooth interface. Production
// code has no simulation switch, fixture import, or alternate connection path.
test.beforeEach(async ({ page }) => {
  await page.route("**/__test__/bluetooth.js", route => route.fulfill({
    contentType: "text/javascript",
    body: readFileSync(new URL("../tests/fixtures/bluetooth.js", import.meta.url), "utf8")
      .replace('"../../src/protocol.js"', '"/src/protocol.js"'),
  }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "bluetooth", { configurable: true, value: {
      getAvailability: async () => true,
      requestDevice: async () => {
        const { mockBluetooth } = await import("/__test__/bluetooth.js");
        return mockBluetooth().requestDevice();
      },
    } });
  });
});

test("real raw Opus download becomes playable Ogg and retains raw export", async ({ page }) => {
  const sample = [...readFileSync(new URL("../tests/note_2026-11-02-07-46-02.opus", import.meta.url))];
  await page.goto("/");
  await page.locator("#connect").click();
  await authorizeDevice(page);
  await page.evaluate(async (sample) => {
    const { Recorder } = await import("/src/recorder.js");
    Recorder.prototype.download = async function () {
      this.emit("download", {
        name: "sample.opus", bytes: new Uint8Array(sample),
        wav: { isWav: false, valid: false }, segment: false,
      });
    };
  }, sample);
  await page.locator('[data-view="files"]').click();
  await page.locator("#listFiles").click();
  await expect(page.locator("#fileRows tr")).toHaveCount(3);
  await page.locator('[data-file="0"]').click();
  await expect(page.locator("#saveFile")).toHaveAttribute("download", "sample.ogg.opus");
  await expect(page.locator("#playbackInfo")).toContainText("20.10 秒");
  await expect.poll(() => page.locator("#player").evaluate(p => p.duration)).toBeCloseTo(20.1, 2);
  const raw = await page.locator("#saveRawFile").evaluate(async link => [...new Uint8Array(await (await fetch(link.href)).arrayBuffer())]);
  expect(raw).toEqual(sample);
});

async function authorizeDevice(page) {
  await expect(page.locator("#deviceName")).toContainText("模拟设备");
  await expect(page.locator("#firmware")).toHaveText("—");
  await expect(page.locator("#refresh")).toBeDisabled();
  await expect(page.locator("#logs .level-TX")).toHaveCount(0);
  await page.locator("#authenticate").click();
  await expect(page.locator("#authStatus")).toHaveText("已授权");
  await expect(page.locator("#firmware")).toHaveText("DEMO.1");
  await expect(page.locator("#refresh")).toBeEnabled();
}

test("authorization is below connection and blocks queries until a valid authorization", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#authKey")).toHaveAttribute("type", "password");
  await expect(page.locator("#authKey")).toHaveValue(/^0x[a-f0-9]{64}$/);
  const defaultKey = await page.locator("#authKey").inputValue();
  expect(
    await page
      .locator("#authPanel")
      .evaluate(
        (panel) =>
          panel.previousElementSibling.classList.contains("connection-card") &&
          panel.nextElementSibling.classList.contains("metrics"),
      ),
  ).toBe(true);
  await expect(page.locator("#authenticate")).toBeDisabled();
  await page.locator("#connect").click();
  await expect(page.locator("#battery")).toContainText("86");
  await expect(page.locator("#refresh")).toBeDisabled();
  await expect(page.locator('[data-record="start"]')).toBeDisabled();
  await page.locator("#authKey").fill("invalid-key-private");
  await page.locator("#authenticate").click();
  await expect(page.locator("#logs")).toContainText("AuthKey 鉴权失败");
  await expect(page.locator("#logs .level-TX")).toHaveCount(0);
  await expect(page.locator("#firmware")).toHaveText("—");
  await expect(page.locator("#refresh")).toBeDisabled();
  await page.locator("#authKey").fill(defaultKey);
  await authorizeDevice(page);
  await expect(
    page
      .locator(".log-line")
      .filter({ has: page.locator(".level-TX") })
      .first(),
  ).toContainText("0-50 AuthKey [已隐藏]");
  await expect(page.locator("#logs")).not.toContainText(defaultKey);
  await expect(page.locator("#logs")).not.toContainText("invalid-key-private");
  await page.locator("#disconnect").click();
  await expect(page.locator("#authStatus")).toHaveText("未授权");
  await expect(page.locator("#refresh")).toBeDisabled();
});

test("session log stays docked across navigation and correlates actions without exposing inputs", async ({
  page,
}) => {
  // Keep the workspace scrollable even with the compact device summary.
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto("/");
  await page.locator("#connect").click();
  await authorizeDevice(page);
  await expect(page.locator("#firmware")).toHaveText("DEMO.1");
  const logNode = await page.locator("#logs").elementHandle();
  const dock = page.getByRole("complementary", { name: "持续会话日志" });
  const initial = await dock.boundingBox();
  expect(initial.x + initial.width).toBe(1440);
  expect(initial.y).toBe(0);
  await page.locator('[data-record="start"]').click();
  await expect(page.locator("#logs")).toContainText("设备录音：开始：处理结束");
  const messages = await page.locator(".log-line").allTextContents();
  const action = messages.find((line) => /ACTION.*设备录音：开始/.test(line));
  const id = action.match(/#\d{4}/)[0];
  expect(
    messages.some((line) => line.includes(`${id} 设备录音：开始：处理结束`)),
  ).toBe(true);
  await page.locator("#authKey").fill("private-invalid-key");
  await page.locator("#authenticate").click();
  await expect(page.locator("#logs")).toContainText("AuthKey 鉴权失败");
  await expect(page.locator("#logs")).not.toContainText("private-invalid-key");
  for (const name of ["live", "files", "debug", "overview"]) {
    await page.locator(`[data-view="${name}"]`).click();
    await expect(dock).toBeVisible();
    expect(
      await logNode.evaluate(
        (node) => node === document.getElementById("logs"),
      ),
    ).toBe(true);
    await expect(page.locator("#logs")).toContainText(`${id} 设备录音：开始`);
  }
  const workspace = page.locator("main");
  const workspaceBox = await workspace.boundingBox();
  expect(workspaceBox.x + workspaceBox.width).toBe(initial.x);
  await workspace.evaluate(el => el.scrollTo(0, el.scrollHeight));
  expect(await workspace.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect((await dock.boundingBox()).y).toBe(0);
  expect(
    await page
      .locator("#logs")
      .evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await page.locator("#logs").evaluate((el) => (el.scrollTop = 0));
  await page.locator('[data-view="live"]').click();
  await expect(page.locator("#logs")).toContainText("切换菜单：实时音频");
  expect(await page.locator("#logs").evaluate((el) => el.scrollTop)).toBe(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(1440);
});

test("recording, live audio decode, download and safe debug", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator("#pageTitle")).toContainText(
    "让录音，直接连接浏览器",
  );
  await page.locator("#connect").click();
  await authorizeDevice(page);
  await expect(page.locator("#firmware")).toHaveText("DEMO.1");
  await page.screenshot({ path: "test-results/overview.png", fullPage: true });
  await page.locator('[data-record="start"]').click();
  await expect(page.locator("#recordState")).toHaveText("录音中");
  await expect(page.locator("#logs")).toContainText("设备录音：开始");
  await expect(page.locator("#logs")).toContainText("处理结束");
  await page.locator('[data-record="save"]').click();
  await expect(page.locator("#recordState")).toHaveText("未录音");
  await page.locator('[data-view="live"]').click();
  await page.locator("#liveStart").click();
  await expect(page.locator("#liveStatus")).toContainText("接收中");
  await expect
    .poll(async () =>
      Number(
        (await page.locator("#livePackets").textContent()).replaceAll(",", ""),
      ),
    )
    .toBeGreaterThan(2);
  await page.locator("#monitor").check();
  await expect(page.locator("#exportWav")).toBeEnabled();
  await page.screenshot({ path: "test-results/live.png", fullPage: true });
  await page.locator("#liveStop").click();
  const capture = page.waitForEvent("download");
  await page.locator("#exportCapture").click();
  expect((await capture).suggestedFilename()).toMatch(/\.vhstream$/);
  await page.locator('[data-view="files"]').click();
  await page.locator("#listFiles").click();
  await expect(page.locator("#fileRows tr")).toHaveCount(3);
  await page.locator('[data-file="0"]').click();
  await expect(page.locator("#downloadStatus")).toHaveText("传输完成");
  await expect(page.locator("#playbackInfo")).toContainText("WAV 校验通过");
  const transferLogs = await page.locator(".log-line").allTextContents();
  const downloadAction = transferLogs.findIndex((line) =>
    /ACTION.*下载设备文件：note20260710-162938/.test(line),
  );
  expect(downloadAction).toBeGreaterThanOrEqual(0);
  const transfer = transferLogs.slice(downloadAction + 1);
  expect(transfer.some((line) => /TX/.test(line))).toBe(true);
  expect(transfer.some((line) => /RX/.test(line))).toBe(true);
  // The same controls still allow an explicit filename and byte range.
  await page.locator("#downloadName").fill("note20260710-162938.wav");
  await page.locator("#offset").fill("100");
  await page.locator("#endOffset").fill("200");
  await page.locator("#download").click();
  await expect(page.locator("#downloadStatus")).toHaveText("传输完成");
  await expect(page.locator("#saveFile")).toHaveAttribute(
    "download",
    /\.part\.bin$/,
  );
  await page.locator('[data-file="0"]').click();
  await expect(page.locator("#playbackInfo")).toContainText("WAV 校验通过");
  const download = page.waitForEvent("download");
  await page.locator("#saveFile").click();
  expect((await download).suggestedFilename()).toBe("note20260710-162938.opus");
  await page.locator('[data-delete="0"]').click();
  await expect(page.locator("#confirmDialog")).toBeVisible();
  await page.locator("#confirmCancel").click();
  await expect(page.locator("#fileRows tr")).toHaveCount(3);
  await page.locator('[data-view="debug"]').click();
  await page.locator("#browserDiagnostics").click();
  await expect(page.locator("#diagnosticResult")).toContainText(
    '"secureContext": true',
  );
  await expect(page.locator("#diagnosticResult")).toContainText(
    '"apiExposed": true',
  );
  await page.locator("#sendRaw").click();
  await page.locator("#confirmOk").click();
  await expect(page.locator("#logs")).toContainText("0-4");
  await page.locator("#settingsOpen").click();
  await page.locator("#nameLength").selectOption("29");
  await page.locator("#settingsSave").click();
  await expect(page.locator("#logs")).toContainText("文件名 29B");
  await page.locator('[data-view="overview"]').click();
  await page.locator("#disconnect").click();
  await expect(page.locator("#authStatus")).toHaveText("未授权");
  expect(errors).toEqual([]);
});

test("mobile layout fits viewport with usable navigation and file table", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#connect").click();
  await authorizeDevice(page);
  await expect(page.locator("#firmware")).toHaveText("DEMO.1");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator('[data-view="live"]').click();
  await expect(page.locator("#liveStart")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator('[data-view="files"]').click();
  await page.locator("#listFiles").click();
  await expect(page.locator("#fileRows tr")).toHaveCount(3);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
