import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Antigravity CLI(`agy`) 실행 파일 경로.
 * 같은 이름의 IDE 런처(~/.antigravity/antigravity/bin/agy, VS Code 계열 셸 스크립트)가 PATH 앞에
 * 올 수 있어 이름만으로는 잘못된 것이 잡힌다. 설치 스크립트가 두는 ~/.local/bin/agy(Go 바이너리)를
 * 우선하고, 없으면 PATH 탐색에 맡긴다. PLURIPLY_AGY_PATH 로 명시할 수 있다.
 * @returns {string}
 */
export function agyCommand() {
  const explicit = process.env.PLURIPLY_AGY_PATH;
  if (explicit) return explicit;
  const local = join(homedir(), ".local", "bin", "agy");
  return existsSync(local) ? local : "agy";
}
