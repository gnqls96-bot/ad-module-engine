#!/usr/bin/env bash
# 데모: 더미 클립으로 엔진 전체를 처음부터 끝까지 돌린다.
#   npm run demo            → ./demo-workspace 에 생성, 렌더링 4편
#   RENDER_LIMIT=0 npm run demo  → 렌더링 건너뛰기
#   VOICE_PROVIDER=auto npm run demo → 실제 무료 TTS로 내레이션 (맥: 내장 음성/MeloTTS, 키가 있으면 구글·애저)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
WS="${DEMO_WS:-$ROOT/demo-workspace}"
LIMIT="${RENDER_LIMIT:-2}"
ame() { node "$ROOT/bin/ame.mjs" -w "$WS" "$@"; }

rm -rf "$WS" && mkdir -p "$WS"
echo "━━ 1. 조직과 계정"
ame init --org "데모 마케팅본부" --admin "후빈"
ame account create --name "팀원A" --role member
ame account create --name "팀원B" --role member
ame account create --name "팀장님" --role admin

echo "━━ 2. 브랜드·제품 (가상 브랜드)"
ame brand create --code DEMO --name "데모 코스메틱" --industry "화장품(예시)" --rulepack example
ame product create --brand DEMO --code SERUM --name "글로우 세럼" \
  --offer price=39000 originalPrice=59000 "headline=첫 구매 특가" deadline=11월30일 gift=미니어처 "cta=지금 구매하기"

echo "━━ 3. 더미 클립 → 모듈 폴더에 넣고 한 번에 등록"
ame dummy "$WS/_incoming"
for k in hook bridge story offer; do cp "$WS/_incoming/$k/"* "$WS/brands/DEMO/SERUM/modules/$k/"; done
ame module scan --brand DEMO --product SERUM
ame module review all approve --brand DEMO --product SERUM
ame module list --brand DEMO --product SERUM

echo "━━ 4. 레퍼런스: 관리자 = 공통, 팀원 = 개인"
ame reference add --title "건조함 역설 후킹 (경쟁사)" --source 스니핏 --run-days 45 --hook-type paradox --story-type problem-first --offer-type discount
ame --as 팀원A reference add --title "팀원A가 찾은 질문형 후킹" --source "메타 광고 라이브러리" --run-days 30 --hook-type question
echo "· 팀원B가 보는 레퍼런스 (팀원A 것은 안 보여야 함)"
ame --as 팀원B reference list
echo "· 관리자가 보는 레퍼런스 (전부)"
ame reference list

echo "━━ 5. 배치: 후킹 테스트 (스토리·오퍼 고정, 후킹 전부)"
ame batch create --brand DEMO --product SERUM --mode hook-test --length 15 --aspects 916,45 --bridge B001 --stories S001 --offers O001 --name demo_hooktest

echo "━━ 6. 팀원 배치 = 승인 대기 → 관리자 승인"
ame --as 팀원A batch create --brand DEMO --product SERUM --mode full --length 15 --aspects 916 --hooks H003,H004,H005,H006 --stories S001,S002 --offers O001,O002 --name a_full
ame --as 팀원B batch list
ame batch approve a_full

if [ "$LIMIT" != "0" ]; then
  echo "━━ 7. 렌더링 (앞 ${LIMIT}개 조합 × 2비율)"
  ame render demo_hooktest --limit "$LIMIT" --now
  echo "━━ 8. 가격 변경 → v2 재렌더링"
  ame batch offer demo_hooktest price=29000 "headline=오늘만 특가"
  ame render demo_hooktest --limit 1 --now
  ame jobs --batch demo_hooktest
fi

echo "━━ 9. 음성: 내레이션 + 음성에 맞춘 자막 (VOICE_PROVIDER, 기본 mock = 시험용 톤)"
ame voice providers | head -8
ame voice set --brand DEMO --provider "${VOICE_PROVIDER:-mock}"
ame module voice H003,B001,S001,O001 --brand DEMO --product SERUM
ame batch create --brand DEMO --product SERUM --mode hook-test --hooks H003 --bridge B001 --stories S001 --offers O001 --length 15 --aspects 916 --name demo_voice
if [ "$LIMIT" != "0" ]; then ame render demo_voice --now; fi

ame batch export demo_hooktest
ame team
echo "━━ 완료: $WS"
