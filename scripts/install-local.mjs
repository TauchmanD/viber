import { chmod, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(projectRoot, "src-tauri/target/release/tmux-agent-grid");
const target = resolve(homedir(), ".local/bin/tmux-agent-grid");
const temporary = `${target}.tmp-${process.pid}`;

try {
  const sourceInfo = await stat(source);
  if (!sourceInfo.isFile()) throw new Error(`Release binary is not a file: ${source}`);

  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, temporary);
  await chmod(temporary, 0o755);
  await rename(temporary, target);
  console.log(`Installed Tmux Agent Grid to ${target}`);
} catch (error) {
  await rm(temporary, { force: true }).catch(() => {});
  console.error(`Could not install the release binary: ${error.message}`);
  process.exitCode = 1;
}
