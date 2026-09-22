# macOS 배포

개발용 `npm run package`와 공개 배포용 빌드를 구분합니다. 공개 배포에는 개인 팀의 **Developer ID Application** 인증서와 Apple 공증이 필요합니다. Apple Distribution 인증서는 이 배포 방식에 사용하지 않습니다.

## 이 Mac에서 한 번 준비하기

1. Xcode의 **Settings → Apple Accounts → 개인 팀 → Manage Certificates → + → Developer ID Application**에서 인증서를 발급합니다. 또는 [Apple Developer의 발급 절차](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)를 따릅니다.
2. `security find-identity -v -p codesigning`으로 인증서와 개인키가 함께 사용 가능한지 확인합니다.
3. Apple 계정의 앱 암호를 발급하고, 아래 명령의 보안 입력 프롬프트에 입력합니다. 일반 Apple 계정 암호를 사용하지 않습니다.

```sh
xcrun notarytool store-credentials sinder-notary \
  --apple-id '<개인 Apple 계정>' \
  --team-id '<개인 팀 ID>'
```

검증에 성공한 프로필은 로그인 키체인에 저장됩니다. 인증서 개인키, 앱 암호, API 키를 저장소나 릴리스 파일에 넣지 않습니다.

## 서명·공증된 Apple Silicon ZIP 만들기

```sh
npm ci
npm test
npm run test:e2e
export CSC_NAME='Developer ID Application: <이름> (<팀 ID>)'
export APPLE_KEYCHAIN_PROFILE='sinder-notary'
npm run release:mac
```

이 명령은 자격증명을 검증한 뒤 앱을 빌드·서명·공증하고 공증 티켓을 앱에 첨부합니다. Hardened Runtime과 JIT 권한을 사용합니다. `codesign`, `stapler`, Gatekeeper 검사 중 하나라도 실패하면 완료로 처리하지 않습니다.

결과는 `release/Sinder-<버전>-arm64-mac.zip`과 `release/SHA256SUMS.txt`입니다. 이 명령은 GitHub에 자동 게시하지 않습니다. 해당 소스 커밋을 태그하고 두 파일을 GitHub Release에 첨부합니다. 실기 확인이 남은 버전은 GitHub의 prerelease로 표시하고, 미검증 동작을 README와 릴리스 안내에 명시합니다. 정식 배포 전에는 Finder 양방향 드래그와 설치 후 실행을 확인합니다. Intel Mac·Windows 배포는 해당 환경의 빌드와 실기 확인이 끝난 뒤 별도로 추가합니다.

발급·공증 참고: [Apple의 공증 절차](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Electron 공증과 키체인 인증](https://github.com/electron/notarize).
