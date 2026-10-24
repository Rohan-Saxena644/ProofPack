import { execFileSync } from 'node:child_process';

if (process.platform !== 'win32') {
  throw new Error(
    'This optional offline narrator uses Windows System.Speech. Supply your own scene WAVs on other platforms.',
  );
}
// Direct commands do not change PowerShell execution policy. No hosted TTS API.
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$demoOutput = [System.IO.Path]::GetFullPath('data/demo-video')
[System.IO.Directory]::CreateDirectory($demoOutput) | Out-Null
$demoScenes = Get-Content -LiteralPath 'docs/video-scenes.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$demoSpeaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $demoSpeaker.SelectVoice('Microsoft David Desktop')
    $demoSpeaker.Rate = 0
    foreach ($demoScene in $demoScenes) {
        $demoSpeaker.SetOutputToWaveFile((Join-Path $demoOutput ($demoScene.id + '.wav')))
        $demoSpeaker.Speak($demoScene.narration)
    }
} finally {
    $demoSpeaker.SetOutputToNull()
    $demoSpeaker.Dispose()
}
Write-Output ('Offline narration generated for ' + $demoScenes.Count + ' scenes.')
`,
  ],
  { stdio: 'inherit' },
);
