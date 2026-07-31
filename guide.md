# 실행 가이드

## 1. 필수 설치

이 앱은 Node.js 기반입니다.

- Node.js 18 이상
- npm

설치 여부 확인:

```bash
node -v
npm -v
```

## 2. 패키지 설치

프로젝트 폴더에서 실행합니다.

```bash
cd /home/wia/projects/crawling
npm install
```

## 3. Playwright 브라우저 설치

처음 한 번만 실행하면 됩니다.

```bash
npx playwright install chromium
```

## 4. 서버 실행

기본 포트는 `9717`입니다.

```bash
npm run manual:autoway
```

다른 포트로 실행하려면:

```bash
PORT=9717 npm run manual:autoway
```

## 5. 접속

브라우저에서 아래 주소로 접속합니다.

```text
http://localhost:9717
```

## 6. 종료

터미널에서 실행 중인 서버를 종료하려면 `Ctrl + C`를 누릅니다.


