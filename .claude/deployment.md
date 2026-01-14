# JolaJoa Memo 배포 가이드

## 배포 구조

```
GitHub Repository
├── GitHub Actions (Release) → GitHub Releases (exe, msi 파일)
├── GitHub Pages → johunsang.github.io/jolajoamemo
└── docs/ → Vercel → www.jolajoa.com
```

---

## 버전 업데이트 체크리스트

버전 올릴 때 **3곳** 수정 필요:

1. `package.json` → `"version": "X.X.X"`
2. `src-tauri/tauri.conf.json` → `"version": "X.X.X"`
3. `docs/index.html` → `JolaJoa.Memo_X.X.X_x64-setup.exe`

---

## 배포 명령어

### 1. 코드 커밋 & 푸시
```bash
git add -A
git commit -m "feat: 변경사항 설명"
git push origin main
```

### 2. 릴리즈 태그 생성 (GitHub Actions 빌드 트리거)
```bash
git tag vX.X.X
git push origin vX.X.X
```

### 3. 릴리즈 퍼블리시
```bash
gh release edit vX.X.X --draft=false --latest
```

### 4. Vercel 홈페이지 배포
```bash
cd docs && vercel --prod
```

---

## 서명 키 설정

### GitHub Secrets 필요 항목
- `TAURI_SIGNING_PRIVATE_KEY` - 서명용 개인키
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` - 개인키 비밀번호

### 서명 키 생성 방법
```bash
# expect로 비밀번호 자동 입력
expect -c '
spawn npm run tauri signer generate -- -w /tmp/mykey.key
expect "password"
send "YOUR_PASSWORD\r"
expect "password"
send "YOUR_PASSWORD\r"
expect eof
'
```

### 키 파일 위치
- Private Key: `/tmp/mykey.key`
- Public Key: `/tmp/mykey.key.pub`

### tauri.conf.json 업데이트
```json
"plugins": {
  "updater": {
    "pubkey": "PUBLIC_KEY_HERE",
    "endpoints": [
      "https://github.com/johunsang/jolajoamemo/releases/latest/download/latest.json"
    ]
  }
}
```

---

## 자주 발생하는 문제

### 1. 서명 키 비밀번호 오류
```
failed to decode secret key: incorrect updater private key password
```
**해결:** GitHub Secrets에서 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 값 확인

### 2. Base64 디코딩 오류
```
Invalid symbol 32, offset 0
```
**해결:** Secret 값에 앞뒤 공백 없이 붙여넣기

### 3. 홈페이지 버전 안 바뀜
**원인:** Vercel 캐시 또는 브라우저 캐시
**해결:**
```bash
cd docs && vercel --prod
```
브라우저에서 `Ctrl + Shift + R` 강력 새로고침

### 4. 태그 재생성 필요할 때
```bash
git tag -d vX.X.X                    # 로컬 태그 삭제
git push origin :refs/tags/vX.X.X   # 원격 태그 삭제
git tag vX.X.X                       # 새 태그 생성
git push origin vX.X.X              # 태그 푸시
```

---

## 자동 업데이트 비활성화/활성화

### 비활성화
`src-tauri/tauri.conf.json`:
```json
"createUpdaterArtifacts": false
```

### 활성화
```json
"createUpdaterArtifacts": "v1Compatible"
```

---

## 빌드 상태 확인
```bash
gh run list --limit 5
gh run view RUN_ID --log-failed
```

---

## 릴리즈 관리
```bash
# 릴리즈 목록
gh release list

# 릴리즈 에셋 확인
gh release view vX.X.X --json assets --jq '.assets[].name'

# Draft를 Latest로 퍼블리시
gh release edit vX.X.X --draft=false --latest
```
