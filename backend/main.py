from __future__ import annotations

import os
import uuid
import json
import re
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
import shutil
import anthropic
import imageio_ffmpeg

app = FastAPI()

ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = Path(__file__).parent
TMP_DIR  = Path(os.environ.get("TMP_DIR", str(BASE_DIR / "tmp")))
TMP_DIR.mkdir(exist_ok=True)

FFMPEG    = imageio_ffmpeg.get_ffmpeg_exe()
YT_DLP    = shutil.which("yt-dlp") or str(BASE_DIR / "venv" / "bin" / "yt-dlp")
ANTHROPIC = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))

# YouTubeクッキーファイル (YOUTUBE_COOKIES_B64 環境変数からBase64デコードして使用)
_COOKIES_FILE: Path | None = None
def _get_cookies_file() -> Path | None:
    global _COOKIES_FILE
    if _COOKIES_FILE and _COOKIES_FILE.exists():
        return _COOKIES_FILE
    b64 = os.environ.get("YOUTUBE_COOKIES_B64", "")
    if not b64:
        return None
    import base64
    _COOKIES_FILE = TMP_DIR / "yt_cookies.txt"
    _COOKIES_FILE.write_bytes(base64.b64decode(b64))
    return _COOKIES_FILE

def _yt_base_args() -> list[str]:
    """yt-dlp共通引数: tv_simplyクライアントでbot検出を回避（クッキー不要）"""
    args = [
        YT_DLP,
        "--extractor-args", "youtube:player_client=tv_simply,mweb,tv,ios",
        "--no-warnings",
    ]
    cf = _get_cookies_file()
    if cf:
        args += ["--cookies", str(cf)]
    return args


def _oembed_meta(video_id: str) -> tuple[str, str]:
    """YouTube oEmbedからタイトルとアップロード者を取得（bot検出なし）"""
    import urllib.request
    try:
        url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("title", ""), data.get("author_name", "")
    except Exception:
        return "", ""


def extract_video_id(url: str) -> str | None:
    patterns = [
        r'(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})',
        r'shorts/([A-Za-z0-9_-]{11})',
    ]
    for pat in patterns:
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return None


def seconds_to_ts(s: float) -> str:
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    return f"{h:02d}:{m:02d}:{sec:02d}" if h > 0 else f"{m:02d}:{sec:02d}"


# ─── Models ────────────────────────────────────────────────────────────────

class TranscriptRequest(BaseModel):
    url: str

class AnalyzeRequest(BaseModel):
    video_id: str
    transcript: str
    instruction: str
    format: str = "9:16"

class ClipRequest(BaseModel):
    video_id: str
    start: float
    end: float
    format: str = "9:16"
    mode: str = "letterbox"  # "letterbox" | "crop"


# ─── Endpoints ─────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok", "ffmpeg": FFMPEG}


@app.post("/api/transcript")
async def get_transcript(req: TranscriptRequest):
    from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled

    video_id = extract_video_id(req.url)
    if not video_id:
        raise HTTPException(400, "YouTube URLが正しくありません")

    # Get metadata via yt-dlp
    meta = subprocess.run(
        _yt_base_args() + [
            "--skip-download", "--print", "%(title)s|||%(duration)s|||%(channel)s",
            "--no-playlist", "--", video_id,
        ],
        capture_output=True, text=True, timeout=40
    )
    title, duration, uploader = "", 0, ""
    if meta.returncode == 0 and "|||" in meta.stdout:
        parts = meta.stdout.strip().split("|||")
        title    = parts[0] if len(parts) > 0 else ""
        duration = int(parts[1]) if len(parts) > 1 and parts[1].strip().isdigit() else 0
        uploader = parts[2].strip() if len(parts) > 2 else ""

    # oEmbedフォールバック: yt-dlpが失敗またはNA返却の場合
    if not title or uploader in ("NA", "N/A", ""):
        title_fb, uploader_fb = _oembed_meta(video_id)
        if not title:
            title = title_fb or f"YouTube動画 ({video_id})"
        if uploader in ("NA", "N/A", "") and uploader_fb:
            uploader = uploader_fb

    # Get transcript
    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
        try:
            t = transcript_list.find_transcript(['ja'])
        except Exception:
            try:
                t = transcript_list.find_transcript(['en'])
            except Exception:
                t = transcript_list.find_generated_transcript(['ja', 'en', 'ja-JP'])

        entries = t.fetch()
        lines = []
        for e in entries:
            sec = e['start']
            lines.append(f"[{seconds_to_ts(sec)}] {e['text']}")
        transcript_text = '\n'.join(lines)

    except (NoTranscriptFound, TranscriptsDisabled):
        transcript_text = ""
    except Exception:
        transcript_text = ""

    return {
        "video_id": video_id,
        "title":    title,
        "duration": duration,
        "uploader": uploader,
        "transcript": transcript_text,
        "has_transcript": bool(transcript_text),
    }


@app.post("/api/analyze")
async def analyze(req: AnalyzeRequest):
    format_label = {
        "9:16":  "縦型（TikTok / YouTube Shorts / Instagram Reels）",
        "16:9":  "横型（YouTube通常動画）",
        "1:1":   "正方形（Instagram投稿）",
    }.get(req.format, req.format)

    transcript_chunk = req.transcript[:80000] if req.transcript else "（字幕なし）"

    prompt = f"""あなたはバズる動画を見抜くプロの動画編集者です。
以下のトランスクリプトを分析し、ユーザーの指示に沿った切り抜き候補を最大5つ提案してください。

【ユーザー指示】
{req.instruction}

【出力形式】
{format_label}

【トランスクリプト】
{transcript_chunk}

必ず以下のJSON配列のみを返してください。前後に説明文を含めないでください。

[
  {{
    "title": "切り抜きのキャッチーなタイトル（30字以内）",
    "start_seconds": 開始秒数（整数）,
    "end_seconds": 終了秒数（整数）,
    "reason": "この部分を選んだ理由（60字以内）",
    "buzz_score": バズり度0-100（整数）,
    "platforms": ["TikTok", "YouTube Shorts"]
  }}
]

注意:
- 各クリップは最低20秒、最大180秒
- buzz_score が高い順に並べる
- platforms は ["TikTok","YouTube Shorts","Instagram Reels","YouTube"] から選ぶ
- 字幕がない場合は動画全体から均等に候補を出す"""

    resp = ANTHROPIC.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2000,
        messages=[{"role": "user", "content": prompt}],
    )

    raw = resp.content[0].text.strip()

    # Extract JSON from possible code block
    if "```" in raw:
        parts = raw.split("```")
        for part in parts:
            part = part.strip()
            if part.startswith("json"):
                part = part[4:].strip()
            if part.startswith("["):
                raw = part
                break

    try:
        clips = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(500, f"AI応答のパースに失敗しました: {raw[:200]}")

    # Enrich with formatted times
    for c in clips:
        c["start_time"]  = seconds_to_ts(c.get("start_seconds", 0))
        c["end_time"]    = seconds_to_ts(c.get("end_seconds", 0))
        dur = c.get("end_seconds", 0) - c.get("start_seconds", 0)
        c["duration_seconds"] = dur
        c["duration_label"]   = seconds_to_ts(dur)

    return {"clips": clips}


@app.post("/api/clip")
async def create_clip(req: ClipRequest):
    job_id      = str(uuid.uuid4())[:8]
    video_path  = TMP_DIR / f"{req.video_id}_{job_id}.%(ext)s"
    video_final = TMP_DIR / f"{req.video_id}_{job_id}.mp4"
    output_path = TMP_DIR / f"clip_{job_id}.mp4"

    try:
        dl_args_list = [
            # 第1試行: tvクライアント
            _yt_base_args() + [
                "--ffmpeg-location", FFMPEG,
                "-f", "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/mp4/18/best[height<=480]",
                "--merge-output-format", "mp4",
                "-o", str(video_path),
                "--no-playlist",
                "--", req.video_id,
            ],
            # 第2試行: mwebクライアント + 低解像度フォーマット
            [
                YT_DLP,
                "--extractor-args", "youtube:player_client=mweb,ios",
                "--no-warnings",
                "--ffmpeg-location", FFMPEG,
                "-f", "best[height<=480]/worst",
                "-o", str(video_path),
                "--no-playlist",
                "--", req.video_id,
            ],
        ]
        dl = None
        for args in dl_args_list:
            dl = subprocess.run(args, capture_output=True, text=True, timeout=300)
            if dl.returncode == 0:
                break

        if dl is None or dl.returncode != 0:
            err = (dl.stderr if dl else "")[-400:]
            if "page needs to be reloaded" in err or "Sign in" in err:
                raise HTTPException(500, "YouTubeのbot検出によりダウンロードがブロックされました。Railway環境変数にYOUTUBE_COOKIES_B64を設定してください。")
            raise HTTPException(500, f"動画のダウンロードに失敗しました: {err}")

        if not video_final.exists():
            # Try finding the file with different extension
            matches = list(TMP_DIR.glob(f"{req.video_id}_{job_id}.*"))
            if not matches:
                raise HTTPException(500, "ダウンロードファイルが見つかりません")
            video_final = matches[0]

        # Build FFmpeg vf filter
        duration = req.end - req.start
        use_crop = req.mode == "crop"

        if req.format == "9:16":
            if use_crop:
                # 拡大クロップ: 画面いっぱい・左右が切れる
                vf = "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920:flags=lanczos"
            else:
                # 全体表示: 元動画全体を上下黒帯で収める（デフォルト）
                vf = (
                    "scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,"
                    "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,"
                    "setsar=1"
                )
        elif req.format == "1:1":
            if use_crop:
                vf = "crop=ih:ih:(iw-ih)/2:0,scale=1080:1080:flags=lanczos"
            else:
                vf = (
                    "scale=1080:1080:force_original_aspect_ratio=decrease:flags=lanczos,"
                    "pad=1080:1080:(ow-iw)/2:(oh-ih)/2:black,"
                    "setsar=1"
                )
        else:
            vf = "scale=1280:720:flags=lanczos"

        ff = subprocess.run([
            FFMPEG, "-y",
            "-ss", str(req.start),
            "-i", str(video_final),
            "-t", str(duration),
            "-map", "0:v:0",
            "-map", "0:a:0",
            "-vf", vf,
            "-c:v", "libx264", "-crf", "20",
            "-c:a", "aac", "-b:a", "128k",
            "-preset", "fast",
            "-movflags", "+faststart",
            str(output_path),
        ], capture_output=True, text=True, timeout=300)

        if ff.returncode != 0:
            raise HTTPException(500, f"動画の生成に失敗しました: {ff.stderr[-500:]}")

        return FileResponse(
            str(output_path),
            media_type="video/mp4",
            filename=f"clip_{job_id}.mp4",
        )

    finally:
        # Cleanup source
        for f in TMP_DIR.glob(f"{req.video_id}_{job_id}.*"):
            try:
                f.unlink()
            except Exception:
                pass
