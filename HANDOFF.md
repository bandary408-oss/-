# 블랙리스트 용병단 — 프로젝트 인수인계 문서

> 새 프로젝트(대화)에서 이 문서 + `ocg-game.zip` 을 올리고 시작하세요. 이 문서만 읽어도 현재 상태와 결정사항을 이어받을 수 있게 정리했습니다.

## 1. 프로젝트 개요
- 폐쇄형 자캐커뮤 텍스트 웹게임. 20~30명, DnD풍 판타지, "신용을 잃은 용병단"이 4주 스토리를 진행.
- 만드는 사람: 우형주 (게임사 분석·기획, 바이브코딩, 한국어로 소통, Windows PC, Node 22).
- 배포: 지금은 로컬 + Cloudflare Tunnel 로 친구 테스트 → 이후 호스팅(무료 티어는 데이터 초기화 위험, 테스트용).

## 2. 확정된 설계 결정
- 계정당 캐릭터 1개, 초대코드 가입. 공유 자원은 "신용"만 (골드·장비는 선물 가능).
- 판정: d20 + 클래스 보정. 전투/조사 중에도 채팅 가능. 서술 보너스 없음(한 줄 서술은 연출용).
- 응원(cheer) 버프 채택. 라운드 로그 = 적 HP 변화 + 아군 HP 변화 + 다음 행동 예고.
- 전투불능(KO) → 그 의뢰 방에서 발언 불가 + 강제 귀환. 솔로 의뢰는 KO = 실패.
- 클래스는 첫 의뢰 시작 후 변경 불가.
- **일반 대화는 트위터(X)식 타임라인으로 전면 교체** (채널/스레드는 화면에서 숨김). 조사·전투는 의뢰 방(실시간 채팅) 유지.

## 3. 구현 현황 (1~5단계 + 타임라인, 전부 완료·테스트 통과)
1. 가입/로그인/프로필/이미지/관리자
2. 채널·스레드(레거시, 백엔드만 남음)
3. 의뢰: 조사 → 전투(d20 엔진), 응원, 타이머, 보상(xp/gold/items), 레벨업·스탯 분배
4. 마을 장터: 채집(체력), 제작, 도박항아리, 판매, 장비(전투 반영), 선물
5. 타임라인: 글/답글/리포스트·인용/하트/멘션/해시태그/알림/신고, 공식 계정 소식(#의뢰 #장터)
6. 파티·레이드(5단계): 의뢰 단위 파티(상시 파티 없음). 파티 2~4명 방장 모집 → 출발. 레이드는 관리자가 엶, 최소 3명·최대 제한 없음, 보스 2페이즈, 같은 레이드 주 1회 전액 보상. 보상 각자 전액, KO 는 경험치 절반, 부활 없음. 적 HP 인원 비례(1인당 +60%). 응원은 구경꾼·쓰러진 사람만. 모집 중도 "진행 중"으로 쳐서 동시 1개. (README 5단계 참고)

## 4. 기술 스택·구조
Node 22, Express 4, Socket.IO 4, better-sqlite3 ^11.5 (Node 24 프리빌드 없음 → Node 22 LTS 사용), multer, sharp, scrypt, HttpOnly 쿠키 세션, CSP `script-src 'self'`(인라인 스크립트 금지), Origin 검사, 레이트리밋.

| 파일 | 역할 |
|---|---|
| server.js | API 본체, 소켓, 인증, 캐릭터/프로필, 관리자 |
| feed.js | 타임라인(글·알림·태그·멘션·관리자 API) |
| runs.js | 의뢰 진행(모집/조사/전투/응원/타이머/보상, 파티·레이드), GET /api/runs |
| town.js / economy.js | 장터 / 경제 순수 규칙 |
| engine.js | d20 판정 엔진(순수 함수) |
| db.js | 스키마·자동 마이그레이션 |
| content/*.json | rules / quests / economy (기획자가 수정, 시작 시 검증·한국어 에러) |
| public/index.html, app.js, style.css, admin.* | 프런트 (app.js 는 단일 IIFE, DOM 은 h() 로만 생성 → XSS 방지) |
| test/*.js | engine 23, economy 11, smoke 104, feed 56, quest 59, town 55, party 60 |

프런트 구조: 뷰 `home | quests | room | town | notif` (+ 모바일 탭 profile/people). `setView()/setTab()`, 타임라인은 `state.feed`, 상세는 `state.detail`, 의뢰 방은 `state.roomId`.

## 5. 주요 환경변수
PORT, DATA_DIR, ADMIN_USERNAME/PASSWORD, QUESTS_FILE, ECONOMY_FILE, RNG_SEED, ROUND_DEADLINE_SEC, ROUND_MIN_SEC, AUTH_RATE_MAX, CHAT_RATE_MAX, ECON_RATE_MAX.

## 6. 작업할 때 알아둘 함정
- 인라인 스크립트 금지(CSP). Playwright 의 `wait_for_function` 문자열은 CSP 에 막힘 → 셀렉터 대기 사용.
- 글자 수: 타임라인 280, 의뢰방 채팅 500.
- 채널 5개(전체, 잡담, 의뢰 게시판, 이벤트, 마을 장터) 가정이 smoke 테스트에 있음.
- Windows: 프로젝트 폴더에서 npm 실행(system32 금지), OneDrive 경로 피하기, `copy .env.example .env`.
- Python 치환 스크립트로 파일 패치 시 앵커 문자열 정확히 확인.

## 7. 다음 후보 (미착수, 우선순위는 사용자와 상의)
- 주간 이벤트/신용 챕터(4주 스토리) 연동(레이드 보상에 신용 연결), DM
- 레거시 채널·스레드 코드 정리 여부
- 호스팅 이전(영구 디스크, DATA_DIR)

## 8. 프로젝트 지침(Instructions)에 붙여넣을 문구
```
이 프로젝트는 우형주의 자캐커뮤 텍스트 웹게임 "블랙리스트 용병단"(Node/Express/Socket.IO/SQLite, 바이브코딩)을 이어서 만든다.
- 한국어로, 간결하게. 비개발자도 따라 할 수 있게 Windows 기준 명령어로 안내한다.
- HANDOFF.md 의 결정사항(계정당 캐릭터 1개, 신용만 공유, d20, 타임라인 중심 + 의뢰 방 채팅)을 기본 전제로 한다.
- 코드 변경 시 기존 테스트(npm test)를 유지·추가하고, 최종 결과는 ocg-game.zip(node_modules, data, .env 제외)로 전달한다.
- 사용자 입력은 항상 textContent/h() 로만 렌더링하고, 인라인 스크립트는 쓰지 않는다(CSP).
- 큰 변경 전에는 범위가 비싸게 틀어질 수 있으면 먼저 짧게 확인한다.
```
