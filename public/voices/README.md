# 귀신 목소리 녹음 파일

귀신 목소리 녹음 파일입니다. `src/audio/GhostVoice.ts`의 `VOICE_FILES`에 경로가 적혀 있고,
파일이 없거나 받기 전이면 합성 목소리로 대신합니다. 새 파일을 넣을 때도 `VOICE_FILES`에 경로를 적습니다.

## 폴더 이름 (성별·나이대)

| 폴더 | 쓰는 귀신 |
| --- | --- |
| `adult-female/` | 긴 머리 여자 귀신 (peeking, crouched, ceiling, wallcrawl, approach, crawling, standing) |
| `child-male/` | 웃는 남자아이 귀신 (smiling) |
| `child-female/`, `adult-male/`, `elderly-female/`, `elderly-male/` | 아직 해당 영상 없음 |

파일 이름은 `<종류>-<번호>.m4a` (종류: `giggle` = 키득거리는 얕은 웃음, `sob` = 흐느낌).
크게 웃는 소리, 통곡, 비명은 넣지 않습니다. 작고 얕은 소리만 씁니다.
예: `adult-female/sob-1.m4a` → `VOICE_FILES['adult-female'] = { sob: ['/voices/adult-female/sob-1.m4a'] }`

## 라이선스

- CC0(퍼블릭 도메인)만 넣습니다. CC-BY는 크레딧 표기가 필요하므로 아래 표에 꼭 적습니다.
- 찾을 곳: freesound.org에서 라이선스 필터를 "Creative Commons 0"으로 두고 검색
  (예: `woman sobbing quiet`, `woman sniffle`, `child giggle`, `creepy giggle`).
- 1~4초, 모노, 앞뒤 무음 잘라서 m4a(AAC)로 변환 (iOS Safari는 ogg를 못 틂):
  `ffmpeg -i in.wav -ac 1 -ar 44100 -af silenceremove=1:0:-50dB,areverse,silenceremove=1:0:-50dB,areverse,loudnorm=I=-20 -c:a aac -b:a 64k out.m4a`

## 출처 기록

| 파일 | 원본 주소 | 만든 사람 | 라이선스 |
| --- | --- | --- | --- |
| `adult-female/sob-1.m4a` | https://opengameart.org/content/crying-female-low-tone-voice-over-vocal-sound-for-character (`4_cry_1.ogg`) | Jean Myna (@JeanMyna_VA) | CC-BY 3.0 — 출처 표시 필요 |
| `adult-female/sob-2.m4a` | 위와 같음 | Jean Myna (@JeanMyna_VA) | CC-BY 3.0 — 출처 표시 필요 |
| `adult-female/sob-3.m4a` | 위와 같음 | Jean Myna (@JeanMyna_VA) | CC-BY 3.0 — 출처 표시 필요 |
| `adult-female/giggle-1.m4a` | https://opengameart.org/content/voice-clip-packs-for-visual-novels-and-rpgs (Mature Female: `noises/laugh.wav`) | cicifyre | CC0 |
| `adult-female/giggle-2.m4a` | 위와 같음 (Mature Female: `noises/small_single_laugh.wav` + `noises/laugh.wav`) | cicifyre | CC0 |
| `adult-female/giggle-3.m4a` | 위와 같음 (Bright Female: `01-laughter.wav` + `02-laughter.wav`) | cicifyre | CC0 |
| `child-male/giggle-1.m4a` | 위와 같음 (Bright Female: `03-laughter.wav`) | cicifyre | CC0 |
| `child-male/giggle-2.m4a` | 위와 같음 (Bright Female: `02-laughter.wav` + `01-laughter.wav`) | cicifyre | CC0 |
| `child-male/giggle-3.m4a` | 위와 같음 (Bright Female: `01-laughter.wav` + `02-laughter.wav`) | cicifyre | CC0 |

### 손질한 내용

- 공통: 모노, 44.1kHz, 앞뒤 무음 자르기, 음량 맞추기(loudnorm, 약 -19 LUFS), 시작 0.02초·끝 0.18초 페이드, AAC 64kbps m4a.
- 흐느낌(`sob-*`): 5.5초 원본을 숨 쉬는 틈에 맞춰 2.2~2.7초 조각 셋으로 나눔 (1: 0.10~2.80초, 2: 2.85~5.45초, 3: 1.12~3.35초).
- 웃음(`giggle-*`): 원본 웃음이 0.4~1.4초로 짧아서, 같은 목소리의 웃음 두 개를 0.4~0.6초 쉼을 두고 이어 붙임.
- 아이 웃음(`child-male/*`): 아이 녹음을 찾지 못해 여자 웃음의 높이를 약 3반음(×1.19) 올림. 길이는 그대로.
- Freesound와 Pixabay는 사이트가 자동 다운로드를 막아(403) 쓰지 못함. CC0 흐느낌은 찾지 못해 CC-BY 파일을 씀.
