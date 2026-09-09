import { join } from "node:path";
import { homedir } from "node:os";

/** @returns {string} 데이터 저장 루트 */
export function pluriplyHome() {
  return process.env.PLURIPLY_HOME || join(homedir(), ".pluriply");
}
