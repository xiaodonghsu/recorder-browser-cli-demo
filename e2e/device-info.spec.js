import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

async function installDevice(page, mode = "ready") {
  await page.route("**/__test__/bluetooth.js", (route) => route.fulfill({
    contentType: "text/javascript",
    body: readFileSync(new URL("../tests/fixtures/bluetooth.js", import.meta.url), "utf8")
      .replace('"../../src/protocol.js"', '"/src/protocol.js"'),
  }));
  await page.addInitScript((mode) => {
    window.snReads = 0;
    Object.defineProperty(navigator, "bluetooth", { configurable: true, value: {
      getAvailability: async () => true,
      requestDevice: async (options) => {
        window.bluetoothOptions = options;
        const { mockBluetooth } = await import("/__test__/bluetooth.js");
        const device = await mockBluetooth().requestDevice();
        const { command, FrameParser } = await import("/src/protocol.js");
        window.snFrames = [];
        const connect = device.gatt.connect;
        device.gatt.connect = async () => {
          const server = await connect();
          const getService = server.getPrimaryService;
          server.getPrimaryService = async (uuid) => {
            if (!uuid.includes("ae20")) throw new Error("Only AE20 is supported");
            const service = await getService(uuid);
            const getCharacteristic = service.getCharacteristic;
            const main = await getCharacteristic("0000ae22-0000-1000-8000-00805f9b34fb");
            service.getCharacteristic = async (uuid) => {
              const characteristic = await getCharacteristic(uuid);
              if (uuid.includes("ae21")) {
                const write = characteristic.writeValueWithoutResponse;
                characteristic.writeValueWithoutResponse = async (bytes) => {
                  const frame = new FrameParser().feed(bytes)[0];
                  if (frame.type !== 0 || frame.cmd !== 12) return write(bytes);
                  window.snReads++;
                  window.snFrames.push([...bytes]);
                  if (mode === "failed") throw new Error("Write failed");
                  const reply = () => {
                    const sn = mode === "empty" ? "" : "G1000897";
                    const response = command(77, 0, 13, new TextEncoder().encode(sn));
                    // Deliver a fragmented 0-13 reply through the actual AE22 listener.
                    for (const part of [response.slice(0, 7), response.slice(7)]) {
                      const buffer = new Uint8Array(part.length + 4);
                      buffer.set(part, 2);
                      main.value = new DataView(buffer.buffer, 2, part.length);
                      main.dispatchEvent(new Event("characteristicvaluechanged"));
                    }
                  };
                  if (mode === "delayed") window.finishSnRead = reply;
                  else reply();
                };
              }
              return characteristic;
            };
            return service;
          };
          return server;
        };
        return device;
      },
    } });
  }, mode);
  await page.goto("/");
  await page.locator("#connect").click();
}

test("SN is read after authorization, refreshed and cleared on disconnect", async ({ page }) => {
  await installDevice(page);
  expect(await page.evaluate(() => window.snReads)).toBe(0);
  expect(await page.evaluate(() => window.bluetoothOptions.optionalServices))
    .toEqual(["0000ae20-0000-1000-8000-00805f9b34fb"]);
  await page.locator("#authenticate").click();
  await expect(page.locator("#deviceSn")).toHaveText("G1000897");
  const frames = await page.evaluate(() => window.snFrames);
  expect(frames).toHaveLength(1);
  expect(frames[0]).toHaveLength(8);
  expect(frames[0][0]).toBe(0x5a);
  expect(frames[0].slice(2)).toEqual([0xe4, 0x2c, 2, 0, 0, 12]);
  // SEQ follows the session counter; the supplied SEQ=0 vector is identical otherwise.
  expect(await page.evaluate(async () => {
    const { command } = await import("/src/protocol.js");
    return [...command(0, 0, 12)];
  })).toEqual([0x5a, 0, 0xe4, 0x2c, 2, 0, 0, 12]);
  await expect(page.locator("#refresh")).toBeEnabled();
  await page.locator("#refresh").click();
  await expect.poll(() => page.evaluate(() => window.snReads)).toBe(2);
  await expect(page.locator("#refresh")).toBeEnabled();
  for (const width of [1440, 1920, 960, 768, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    const boxes = await page.locator(".metric").evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect();
      return { top: rect.top, height: rect.height, overflows: node.scrollWidth > node.clientWidth };
    }));
    expect(boxes).toHaveLength(5);
    expect(boxes.every(box => !box.overflows)).toBe(true);
    expect(boxes.every(box => box.height < 120)).toBe(true);
    if (width > 650) expect(new Set(boxes.map(box => box.top)).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.locator("#disconnect").click();
  await expect(page.locator("#deviceSn")).toHaveText("—");
});

for (const mode of ["failed", "empty"]) {
  test(`optional SN ${mode} does not block device information`, async ({ page }) => {
    await installDevice(page, mode);
    await page.locator("#authenticate").click();
    await expect(page.locator("#deviceSn")).toHaveText("未知");
    await expect(page.locator("#firmware")).toHaveText("DEMO.1");
    await expect(page.locator("#recordState")).toHaveText("未录音");
    await expect(page.locator("#refresh")).toBeEnabled();
  });
}

test("a delayed SN response cannot restore information after disconnection", async ({ page }) => {
  await installDevice(page, "delayed");
  await page.locator("#authenticate").click();
  await expect.poll(() => page.evaluate(() => window.snReads)).toBe(1);
  await page.locator("#disconnect").click();
  await page.evaluate(() => window.finishSnRead());
  await expect(page.locator("#refresh")).toBeDisabled();
  await expect(page.locator("#snHint")).toHaveText("授权后读取");
  await expect(page.locator("#deviceSn")).toHaveText("—");
});

test("SN timeout continues queries and ignores a late result", async ({ page }) => {
  await installDevice(page, "delayed");
  await page.locator("#authenticate").click();
  await expect.poll(() => page.evaluate(() => window.snReads)).toBe(1);
  await expect(page.locator("#deviceSn")).toHaveText("未知", { timeout: 7000 });
  await expect(page.locator("#firmware")).toHaveText("DEMO.1");
  await expect(page.locator("#refresh")).toBeEnabled();
  await page.evaluate(() => window.finishSnRead());
  await expect(page.locator("#deviceSn")).toHaveText("未知");
});
