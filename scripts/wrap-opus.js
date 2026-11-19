import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { recorderOpusToOgg } from "../src/ogg-opus.js";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("用法: node scripts/wrap-opus.js input.opus output.ogg.opus");
  process.exitCode = 1;
} else if (resolve(input) === resolve(output)) {
  throw new Error("输出路径必须与原始文件不同");
} else {
  const bytes = await readFile(input);
  // Never overwrite an existing output, including via an alias/hard link.
  await writeFile(output, recorderOpusToOgg(bytes), { flag: "wx" });
  console.log(`已封装 ${bytes.length / 40} 包，${bytes.length / 40 * 0.02} 秒 → ${output}`);
}
