import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 아무 설정도 없는 임시 홈. 진짜 홈을 건드리지 않게 하는 기본값. */
export function emptyHome() {
  return mkdtempSync(join(tmpdir(), "plp-home-"));
}

/**
 * codex·agy 가 `mcp add` 로 만들었을 파일을 미리 둔 임시 홈. 테스트의 가짜 exec 는 파일을 쓰지
 * 않으므로 등록 뒤 타임아웃 쓰기가 성공하려면 이 상태가 필요하다.
 * @returns {{home: string, codexToml: string, agyJson: string}}
 */
export function seededHome() {
  const home = emptyHome();
  mkdirSync(join(home, ".codex"), { recursive: true });
  const codexToml = join(home, ".codex", "config.toml");
  writeFileSync(
    codexToml,
    'model = "gpt"\n\n[mcp_servers.pluriply]\ncommand = "node"\n\n[mcp_servers.other]\ncommand = "x"\n',
  );
  mkdirSync(join(home, ".gemini", "config"), { recursive: true });
  const agyJson = join(home, ".gemini", "config", "mcp_config.json");
  writeFileSync(
    agyJson,
    JSON.stringify(
      { mcpServers: { pluriply: { command: "node", disabled: false } } },
      null,
      2,
    ),
  );
  return { home, codexToml, agyJson };
}
