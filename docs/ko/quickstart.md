# Pluriply 시작 가이드 (한국어)

## Pluriply 가 뭔가요?

내 컴퓨터에 깔린 AI 코딩 도구들(Claude Code, Codex, Antigravity 등)을 **하나의 채널로 묶어 서로 일을 맡기게** 해 주는 도구입니다.

예를 들어 Claude Code 에서 "Codex 한테 이 테스트가 왜 실패하는지 찾아 달라고 맡겨 줘" 라고 하면, Codex 가 그 일을 받아 처리하고 결과를 Claude Code 로 돌려줍니다. 서로의 변경사항을 리뷰시키거나 질문을 주고받을 수도 있습니다.

모든 것은 내 컴퓨터 안에서만 돕니다. 서버도, 계정도 없습니다(데이터는 `~/.pluriply/`).

## 준비물

- Node.js 20 이상
- macOS(검증됨). Linux 는 될 것으로 보고, Windows 는 아직 검증 전입니다.
- 아래 도구 중 **두 개 이상**: Claude Code(CLI), Codex(CLI), Antigravity CLI(`agy`), Claude Desktop, Antigravity IDE

## 설치 (1분)

```sh
npx pluriply setup
```

설치된 AI 도구를 찾아 Pluriply 연결(MCP)을 등록합니다. 몇 번 다시 실행해도 괜찮습니다.

- 무엇이 바뀌는지 먼저 보려면: `npx pluriply setup --dry-run`
- 상대 도구 창이 열려 있지 않을 때도 일을 맡기거나, **질문하기**(아래 5번)를 쓰려면 백그라운드 워커가 필요합니다: `npx pluriply setup --workers`
  - 도구별로 켜고 끌 수도 있습니다: `npx pluriply worker enable codex`, `npx pluriply worker list`

**설치 뒤에는 쓰고 있던 AI 도구를 모두 다시 시작하세요.** 그래야 새 연결을 불러옵니다. Codex 는 처음 실행할 때 새 훅(Stop hook)을 신뢰할지 묻습니다 — 승인해야 일이 왔을 때 알아챕니다.

## 첫 협업 (3분)

도구 이름(`join_channel` 등)을 외울 필요는 없습니다. 각 AI 에게 말로 부탁하면 알아서 Pluriply 도구를 부릅니다.

1. **채널 만들기** — 첫 번째 도구(예: Claude Code)에서:

   > pluriply 채널을 새로 만들어 줘

   `plp-xxxx-xxxx` 같은 채널 코드가 나옵니다.

2. **채널에 들어오기** — 두 번째 도구(예: Codex)에서:

   > pluriply 채널 plp-xxxx-xxxx 에 들어가 줘

   한 번 들어간 도구는 마지막 활동 후 12시간 안에 같은 폴더에서 Pluriply 를 다시 쓰면 직전 채널로 알아서 돌아옵니다. 그보다 오래됐으면 같은 채널 코드로 다시 들어가세요("Join a channel first" 오류가 나면 이 경우입니다).

3. **일 맡기기** — 첫 번째 도구에서:

   > Codex 한테 이 저장소에서 실패하는 테스트 원인을 찾아서 고쳐 달라고 맡겨 줘

   Codex 창이 열려 있으면 그 세션이 받고, 없으면(워커를 켰다면) 백그라운드 Codex 가 받아 처리합니다. 끝나면 결과가 첫 번째 도구로 돌아옵니다.

4. **리뷰 받기**:

   > Codex 한테 지금 내 변경사항 리뷰 받아 줘

   상대 도구가 읽기 전용으로 검토하고 심각도별 지적을 돌려줍니다.

5. **질문하기** — 질문은 늘 백그라운드 워커가 답하므로 먼저 `npx pluriply worker enable codex` 로 워커를 켜 두세요:
   > Codex 한테 이 함수가 왜 이렇게 짜였는지 물어봐 줘

### Codex 를 쓴다면: `pluriply codex` 로 띄우세요

```sh
npx pluriply codex
```

평범한 `codex` 대신 이렇게 띄우면, 쉬고 있는 Codex 세션도 일이 오면 **스스로 깨어나** 처리합니다(`codex` 인자는 그대로 쓸 수 있습니다. 예: `npx pluriply codex resume --last`). 평범한 `codex` 로 띄운 세션은 다음 턴이 끝날 때 새 일을 알아챕니다.

## 화면으로 보기

```sh
npx pluriply view
```

브라우저에 로컬 페이지가 열려, 연결된 도구와 채널, 오간 요청과 결과를 한눈에 볼 수 있습니다. 응답하는 쪽의 작업 과정은 보이지 않고 요청과 결과만 보입니다. AI 에게 "Pluriply 화면 열어 줘"라고 말해도 됩니다.

이 페이지는 이 컴퓨터에서만 열립니다(`127.0.0.1`, 실행마다 새로 만든 키로 보호). 허브가 꺼져 있어도 지난 내역은 계속 볼 수 있고, 열린 페이지가 없으면 30분 뒤 스스로 종료됩니다. 바로 끄려면 다음을 실행하세요.

```sh
npx pluriply view stop
```

## 상태 확인과 문제 해결

```sh
npx pluriply status
```

허브와 연결된 세션 목록이 나옵니다.

- `✓` 정상
- `✗` 옛 코드로 돌고 있어 **다시 시작해야** 하는 세션 — 다시 시작하는 방법이 바로 아래 줄에 나옵니다.
- `~` 옛 코드지만 그대로 써도 되는 세션(다시 시작은 선택)
- 아래쪽에 최근 24시간 동안 전달·깨우기에 실패한 일이 있으면 함께 보여 줍니다.

자주 쓰는 명령:

```sh
npx pluriply hub restart        # 허브 다시 시작(업데이트 뒤 등)
npx pluriply setup --remove     # 모든 도구에서 Pluriply 등록 해제(데이터는 남음, --purge 를 붙이면 삭제)
```

업데이트하거나 npx 캐시를 지운 뒤에는 `npx pluriply@latest setup --hooks-only` 를 한 번 실행하세요.

## 써 보고 알려 주세요

다 써 보셨다면 아래 질문에 짧게라도 답해 주시면 큰 도움이 됩니다.

1. 어떤 도구 조합으로 써 보셨나요?
2. 실제로 맡겨 본 일은 무엇이었나요? 결과는 쓸 만했나요?
3. 설치나 첫 협업에서 막힌 곳이 있었나요? 어디서요?
4. 가장 유용했던 순간과 가장 답답했던 순간은?
5. 앞으로도 쓰실 것 같나요? 그렇지 않다면 무엇이 있으면 쓰시겠어요?

남기는 곳: [사용 후기 남기기](https://github.com/pluriply/pluriply/issues/new?template=feedback.yml) · 버그는 [버그 신고](https://github.com/pluriply/pluriply/issues/new?template=bug_report.yml)

영어 문서: [README](https://github.com/pluriply/pluriply#readme)
