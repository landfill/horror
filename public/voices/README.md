# 귀신 목소리 녹음 파일

지금은 녹음 파일 없이 `src/audio/GhostVoice.ts`의 합성 목소리를 씁니다.
실제 사람 목소리로 바꾸려면 이 폴더에 파일을 넣고 `VOICE_FILES`에 경로를 적으면 됩니다.

## 폴더 이름 (성별·나이대)

| 폴더 | 쓰는 귀신 |
| --- | --- |
| `adult-female/` | 긴 머리 여자 귀신 (peeking, crouched, ceiling, wallcrawl, approach, crawling, standing) |
| `child-male/` | 웃는 남자아이 귀신 (smiling) |
| `child-female/`, `adult-male/`, `elderly-female/`, `elderly-male/` | 아직 해당 영상 없음 |

파일 이름은 `<종류>-<번호>.ogg` (종류: `laugh`, `cry`, `sob`, `whisper`).
예: `adult-female/sob-1.ogg` → `VOICE_FILES['adult-female'] = { sob: ['/voices/adult-female/sob-1.ogg'] }`

## 라이선스

- CC0(퍼블릭 도메인)만 넣습니다. CC-BY는 크레딧 표기가 필요하므로 아래 표에 꼭 적습니다.
- 찾을 곳: freesound.org에서 라이선스 필터를 "Creative Commons 0"으로 두고 검색
  (예: `woman sobbing`, `woman whisper`, `child laugh`, `creepy giggle`).
- 1~4초, 모노, 앞뒤 무음 잘라서 ogg로 변환:
  `ffmpeg -i in.wav -ac 1 -ar 44100 -af silenceremove=1:0:-50dB,areverse,silenceremove=1:0:-50dB,areverse -c:a libvorbis -q:a 4 out.ogg`

## 출처 기록

| 파일 | 원본 주소 | 만든 사람 | 라이선스 |
| --- | --- | --- | --- |
