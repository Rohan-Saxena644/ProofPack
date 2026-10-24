# Local software demo video

The demo records the actual production application and inspects completed **Groq / GPT-OSS 120B** runs. It does not simulate new inference or replay fake progress. A separate presentation frame supplies captions, chapter numbers and a progress bar around the unchanged product UI. Its header identifies the saved runs and synthetic narration.

The completed narrated MP4 is **3 minutes 19 seconds**, 1600 × 900, approximately 7.5 MB, at `data/demo-video/proofpack-demo.mp4`. `proofpack-demo-silent.mp4` keeps the captions without narration, and `proofpack-demo.srt` supplies approximate timing for the spoken transcript. Supporting files include chapter screenshots, WAV narration, raw WebM, a self-contained exported HTML report, Markdown and a downloaded Playwright trace. These generated files stay under ignored `data/`; they are not application dependencies. [Verification metadata](video-verification.json) records the actual output, checksum, complete audio/video decode and audio level. Frames from the encoded MP4 were opened for visual inspection. [Scene text](video-scenes.json) contains the captions and editable narration.

The video covers the feature brief, model configuration, four passing assertions, executed actions, passing evidence, the broken application's final failed assertion, its screenshot, retained attempts/retry limit, exports, standalone HTML and the disabled retention policy. Read [the brief project explanation](project-overview.md) for an introduction you can adapt in your own voice.

## Reproduce on this Windows workspace

Start the built local app with `npm.cmd run start:all`. The recording script verifies the two specific saved live run IDs before recording and refuses to invent replacement outcomes. A fresh installation must supply its own genuinely completed live runs and update those source IDs before recording.

```powershell
# Uses an installed Windows voice; does not change execution policy or call a TTS API.
node scripts/narrate-demo.mjs
# FFmpeg must support H.264/AAC. Set DEMO_FFMPEG to your installed executable if needed.
# This workspace's pinned encoder is under ignored data/video-tools/ffmpeg.exe.
New-Item -ItemType Directory -Force -Path data/demo-video/tmp | Out-Null
$env:TEMP = (Resolve-Path data/demo-video/tmp).Path
$env:TMP = $env:TEMP
npx.cmd tsx scripts/record-demo.ts --rehearse
npx.cmd tsx scripts/record-demo.ts
```

The temporary-directory settings apply to that terminal and its child processes. They keep this recording's browser profiles on the project drive. No system-wide settings are changed. The optional offline narrator uses Microsoft David Desktop through Windows System.Speech; on other platforms, provide per-scene WAV files or record your own voice. FFmpeg is tooling for this video, not a new application package.

The recording checks real persistence coverage, loaded screenshot evidence, disabled retry, downloaded HTML/Markdown/ZIP, embedded screenshots in independent HTML rendering, zero page errors, no mutation requests and unchanged history. It makes no new model calls and applies no retention jobs. Recorded elapsed times and token counts are those of the original runs, not the walkthrough's duration.

No deployment, video upload or social post is performed. Review the MP4 locally before sharing it.
