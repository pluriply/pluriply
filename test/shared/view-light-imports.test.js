import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 다른 명령의 기동 비용을 지킨다: 이 파일들은 화면 서버·런처를 정적으로 가져오지 않는다.
const FILES = [
  "../../bin/pluriply.js",
  "../../src/shared/status-format.js",
  "../../src/setup/run-setup.js",
  "../../src/connector/tools.js",
  "../../src/shared/hints.js",
  "../../src/shared/view-lock.js",
];

for (const rel of FILES) {
  test(`${rel.replace("../../", "")} has no static import of view-launch or view/server`, () => {
    const src = readFileSync(
      fileURLToPath(new URL(rel, import.meta.url)),
      "utf8",
    );
    const statics =
      src.match(/^\s*(?:import|export)\b[^;]*?from\s+["'][^"']+["']/gm) ?? [];
    for (const line of statics)
      assert.doesNotMatch(line, /view-launch|view\/server/, line);
  });
}
