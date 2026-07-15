import { copyFile, mkdir } from "node:fs/promises";

await mkdir("public/vendor", { recursive: true });
await Promise.all([
  copyFile("node_modules/@xterm/xterm/lib/xterm.js", "public/vendor/xterm.js"),
  copyFile("node_modules/@xterm/xterm/css/xterm.css", "public/vendor/xterm.css"),
  copyFile("node_modules/@xterm/addon-fit/lib/addon-fit.js", "public/vendor/addon-fit.js")
]);
