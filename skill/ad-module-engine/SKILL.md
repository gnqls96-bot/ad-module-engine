---
name: ad-module-engine
description: 광고 영상 모듈(후킹·브릿지·스토리·오퍼)을 조합해 소재를 대량 렌더링하는 ad-module-engine(ame)을 말로 조작할 때 사용. "후킹 테스트 만들어줘", "이 영상 모듈로 등록해줘", "가격 바꿔서 다시 뽑아줘", "레퍼런스 반영해서 후킹 써줘", "팀원별 현황" 같은 요청.
---

# ad-module-engine 조작 스킬

이 스킬은 사용자의 말을 `ame` 명령으로 바꿔 실행하고, 결과를 쉬운 말로 알려준다.
엔진 설명서: 저장소의 README.md. 명령 목록: `ame --help`, `ame <명령> --help`.

## 먼저 확인할 것

1. 작업 공간 폴더: 사용자가 말한 폴더, 없으면 `AME_WORKSPACE` 환경변수, 없으면 물어본다. 모든 명령에 `-w <폴더>`를 붙인다.
2. 지금 계정: `ame -w <폴더> whoami`. 관리자인지 팀원인지에 따라 할 수 있는 일과 보이는 데이터가 다르다.
3. 실행: 저장소 폴더에서 `node bin/ame.mjs ...` (또는 `npm link` 후 `ame ...`).

## 요청 → 명령

| 사용자가 말하면 | 실행 |
| --- | --- |
| "영상 넣어놨어, 등록해줘" | `ame module scan --brand B --product P` → 경고(규격, 차단·주의 표현)를 요약해 전달 |
| "이 파일 후킹으로 등록" | `ame module add <파일> --brand B --product P --kind hook --transcript "..." --hook-type ... --compat topic:...` |
| "심의 통과시켜줘" (관리자) | `ame module review <코드 또는 all> approve --brand B --product P` |
| "후킹 테스트 만들어줘" | `ame batch create --mode hook-test --stories S00x --offers O00x [--bridge B00x] --length 30 --aspects 916,45` |
| "오퍼별로 비교" | `--mode offer-test --hooks H00x --stories S00x` |
| "렌더링 돌려줘" | `ame render <배치> --now` (오래 걸리면 `ame render <배치>` 후 `ame worker`를 백그라운드로) |
| "가격 바꿔서 다시" | `ame batch offer <배치> price=29000` → `ame render <배치> --now` (버전이 올라간 새 소재가 생김) |
| "조합 목록 엑셀로" | `ame batch export <배치>` |
| "팀원별 현황" (관리자) | `ame team` |
| "팀장님 관리자 계정 만들어줘" (관리자) | `ame account create --name 팀장님 --role admin` |
| "이 레퍼런스 저장해줘" | `ame reference add --title ... --source 스니핏 --run-days N --hook-type ...` |
| "내레이션 넣어줘", "TTS로 읽혀줘" | `ame module voice <코드 또는 all> --brand B --product P` → 경고(음성이 영상보다 김 등) 전달 |
| "촬영본 자막 맞춰줘" | `ame module align <코드 또는 all> --brand B --product P` |
| "목소리 비교해보고 싶어" | `ame voice sample "문장"` → 작업 공간 voice-samples/ 파일 경로 안내 |
| "유료로 바꿔줘", "일레븐랩스로" (관리자) | 키가 환경 변수에 있는지 `ame voice providers`로 확인 → `ame voice set --brand B --provider elevenlabs --voice <ID>` → `ame module voice all ... --force` |
| "무료로 돌려줘" | `ame voice set --brand B --provider auto` |

## 레퍼런스를 반영해 후킹·대본을 쓸 때

1. `ame -w <폴더> reference context --brand B` 를 실행해 **이 계정에 적용되는 레퍼런스**만 받는다.
   - 관리자: 공통 + 모든 팀원 레퍼런스
   - 팀원: 공통 + 본인 레퍼런스 (다른 팀원 것은 절대 쓰지 않는다)
2. "많이 쓰인 패턴"에서 게재 일수가 긴 유형을 우선 쓰고, 레퍼런스 대사를 그대로 베끼지 않는다.
3. 분류 체계(`ame taxonomy --brand B`)의 유형 이름으로 각 후킹에 유형을 붙여 제안한다. 등록할 때 같은 값을 `--hook-type`에 쓴다.
4. 브랜드 규칙 팩의 차단·주의 표현은 쓰지 않는다 (`config/rulepacks/<id>.json`).

## 지킬 것

- 팀원 계정으로 다른 팀원 데이터를 보려는 요청은 권한상 안 된다고 답한다 (우회하지 않는다).
- 렌더링은 시간이 걸린다(짧은 영상 1편에 수십 초~수 분). 많이 돌릴 때는 개수를 먼저 알려준다.
- 검사에서 제외된 조합은 `ame batch show`의 "이유"를 그대로 쉬운 말로 설명한다.
- 결과 파일 경로는 작업 공간 기준 상대 경로로 알려준다.
- API 키를 대화에 붙여넣으면 저장하지 말고, 환경 변수로 넣도록 안내한다 (맥: ~/.zshrc 에 export, 윈도우: setx 이름 "값" 후 터미널 다시 열기).
- 맥·윈도우 모두 같은 명령을 쓴다. 내장 음성만 다르다 (맥 macos-say, 윈도우 windows-tts).
- 유료 제공자(elevenlabs)로 바꾸기 전에 과금된다는 점을 한 줄로 알린다.
