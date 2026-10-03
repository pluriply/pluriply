// Plan 6a(스펙 §4): 부품별 코드 지문. 프로세스가 기동 때 남긴 지문과 디스크의 지문을 비교해
// 옛 코드로 도는 허브·커넥터를 가린다. npm 설치본(허브가 번들 한 파일)과 개발 체크아웃 모두
// "그 폴더 아래 전부"라는 같은 규칙으로 계산한다 — 비교는 늘 같은 설치본 안에서 일어난다.
// version 은 지문에 넣지 않는다(코드가 같으면 버전만 올려도 재시작 대상이 아니다). 반환값의 version 은 표시용이다.
// Plan 6e: 지문은 "다른 코드"만 말한다. 열린 세션이 "재시작해야 하는가"는 재시작 번호(package.json 의
// pluriply.connectorRestart — 사람이 올린다)가 말한다: 번호가 다르면 재시작, 번호가 같고 지문만 다르면 선택.
// 번호를 모르면(옛 커넥터·옛 허브·읽기 실패) 지문만으로 판정한다. 허브는 번호를 쓰지 않는다(지문만).
// 한계: 커넥터는 hub-client.js 가 `../hub/index.js` 로 들여오는 허브 수명주기 코드(liveHub/spawnHub)와 node_modules
// 의존성도 실행하지만 커넥터 지문은 이를 덮지 않는다 — 그것만 바꾼 릴리스는 커넥터 재시작 대상으로 표시되지 않는다(드물어 감수한다).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PARTS = {
  hub: ["src/hub", "src/shared"],
  connector: ["src/connector", "src/shared"],
};

/**
 * 재시작 번호로 쓸 수 있는 값만 통과시킨다(Plan 6e §3): 0 이상 정수면 그 값, 아니면 null.
 * @param {unknown} v @returns {number|null}
 */
export function restartLevel(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** 이 모듈 기준 설치 루트(`src/shared` 의 두 단계 위) @returns {string} */
export function installRoot() {
  return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

/** @param {string} dir @returns {string[]} 절대 경로(재귀), 점 파일·에디터 임시 파일(~로 끝남)은 건너뜀 */
function listFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    if (n.startsWith(".") || n.endsWith("~")) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

/**
 * 부품의 코드 지문. 읽기 실패(루트·폴더 없음, 권한, 읽는 중 교체)는 던지지 않고 null.
 * @param {string} root 설치 루트 @param {"hub"|"connector"} part
 * @returns {{version: string|null, fingerprint: string, restart: number|null}|null}
 *   restart 는 package.json 의 재시작 번호(부품과 무관하게 같은 값, 없거나 이상하면 null)
 */
export function codeFingerprint(root, part) {
  const dirs = PARTS[part];
  if (!dirs || typeof root !== "string") return null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const version = typeof pkg.version === "string" ? pkg.version : null;
    const h = createHash("sha256");
    for (const d of dirs) {
      const files = listFiles(join(root, d))
        .map((p) => relative(root, p).split(sep).join("/"))
        .sort();
      for (const f of files) {
        h.update(`${f}\0`);
        h.update(readFileSync(join(root, f)));
        h.update("\0");
      }
    }
    return {
      version,
      fingerprint: h.digest("hex").slice(0, 12),
      restart: restartLevel(pkg?.pluriply?.connectorRestart),
    };
  } catch {
    return null;
  }
}
