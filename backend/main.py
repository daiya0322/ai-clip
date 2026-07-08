from __future__ import annotations

import os
import uuid
import json
import re
import subprocess
import time
from pathlib import Path

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

# Dockerfileでシステムffmpegをインストール済みならそちらを優先
_SYSTEM_FFMPEG = shutil.which("ffmpeg")
FFMPEG = _SYSTEM_FFMPEG or imageio_ffmpeg.get_ffmpeg_exe()

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


def _yt_base_args(player_client: str = "tv_simply") -> list[str]:
    """yt-dlp共通引数。player_clientでクライアントを切り替え可能"""
    args = [
        YT_DLP,
        "--extractor-args", f"youtube:player_client={player_client}",
        "--no-warnings",
        "--no-check-certificates",
    ]
    cf = _get_cookies_file()
    if cf:
        args += ["--cookies", str(cf)]
    return args


def _classify_ytdlp_error(stderr: str) -> str:
    """yt-dlpのエラーを分類してユーザー向けメッセージに変換"""
    s = stderr.lower()
    if "sign in" in s or "bot" in s or "confirm you" in s:
        return (
            "YouTubeのbot検出によりブロックされました。\n"
            "別の動画で試すか、しばらく時間をおいてから再試行してください。"
        )
    if "video unavailable" in s or "private video" in s:
        return "動画が非公開または削除されています"
    if "copyright" in s or "blocked" in s:
        return "著作権の制限により、この動画はダウンロードできません"
    if "rate limit" in s or "429" in s:
        return "YouTubeのレート制限に引っかかりました。しばらく待ってから再試行してください"
    if "network" in s or "connection" in s or "timeout" in s:
        return "ネットワークエラーが発生しました。再試行してください"
    return f"動画のダウンロードに失敗しました: {stderr[-300:]}"


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


def _oembed_meta(video_id: str) -> tuple[str, str]:
    """YouTube oEmbedからタイトルとアップロード者を取得"""
    import urllib.request
    try:
        url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("title", ""), data.get("author_name", "")
    except Exception:
        return "", ""


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
    try:
        cf = _get_cookies_file()
        cookie_size = cf.stat().st_size if cf and cf.exists() else 0
    except Exception:
        cf = None
        cookie_size = 0
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    return {
        "status": "ok",
        "ffmpeg": str(FFMPEG) if FFMPEG else None,
        "yt_dlp": str(YT_DLP) if YT_DLP else None,
        "has_youtube_cookies": bool(os.environ.get("YOUTUBE_COOKIES_B64")),
        "cookies_file": str(cf) if cf else None,
        "cookies_file_size": cookie_size,
        "has_anthropic_key": bool(api_key) and api_key != "your_api_key_here",
    }


@app.post("/api/transcript")
async def get_transcript(req: TranscriptRequest):
    from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled

    video_id = extract_video_id(req.url)
    if not video_id:
        raise HTTPException(400, "YouTube URLが正しくありません")

    # Get metadata via yt-dlp（複数クライアントでフォールバック）
    title, duration, uploader = "", 0, ""
    for client in ["web", "ios", "tv_simply"]:
        meta = subprocess.run(
            _yt_base_args(client) + [
                "--skip-download", "--print", "%(title)s|||%(duration)s|||%(channel)s",
                "--no-playlist", "--", video_id,
            ],
            capture_output=True, text=True, timeout=40
        )
        if meta.returncode == 0 and "|||" in meta.stdout:
            parts = meta.stdout.strip().split("|||")
            title    = parts[0] if len(parts) > 0 else ""
            duration = int(parts[1]) if len(parts) > 1 and parts[1].strip().isdigit() else 0
            uploader = parts[2].strip() if len(parts) > 2 else ""
            if title and title != "NA":
                break

    # oEmbedフォールバック
    if not title or title == "NA":
        title_fb, uploader_fb = _oembed_meta(video_id)
        if not title or title == "NA":
            title = title_fb or f"YouTube動画 ({video_id})"
        if uploader in ("NA", "N/A", "") and uploader_fb:
            uploader = uploader_fb

    # Get transcript（youtube-transcript-api 0.x / 1.x 両対応）
    transcript_text = ""
    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
        t = None
        # 手動字幕 (ja → en の順)
        for lang in ['ja', 'en']:
            try:
                t = transcript_list.find_transcript([lang])
                break
            except Exception:
                continue
        # 自動生成字幕（メソッド名が 1.x で変わったため両方試す）
        if t is None:
            try:
                t = transcript_list.find_generated_transcript(['ja', 'en', 'ja-JP'])
            except AttributeError:
                try:
                    t = transcript_list.find_automatically_generated_transcript(['ja', 'en'])
                except Exception:
                    pass
            except Exception:
                pass

        if t is not None:
            entries = t.fetch()
            lines = []
            for e in entries:
                # 0.x: dict形式、1.x: オブジェクト形式（どちらも対応）
                try:
                    start = e['start']
                    text  = e['text']
                except (TypeError, KeyError):
                    start = getattr(e, 'start', 0)
                    text  = getattr(e, 'text', '')
                lines.append(f"[{seconds_to_ts(float(start))}] {text}")
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
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key or api_key == "your_api_key_here":
        raise HTTPException(
            500,
            "ANTHROPIC_API_KEY が設定されていません。backend/.env の ANTHROPIC_API_KEY に本物のAPIキーを設定してください。"
        )

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

    for c in clips:
        c["start_time"]       = seconds_to_ts(c.get("start_seconds", 0))
        c["end_time"]         = seconds_to_ts(c.get("end_seconds", 0))
        dur                   = c.get("end_seconds", 0) - c.get("start_seconds", 0)
        c["duration_seconds"] = dur
        c["duration_label"]   = seconds_to_ts(dur)

    return {"clips": clips}


@app.post("/api/clip")
async def create_clip(req: ClipRequest):
    job_id      = str(uuid.uuid4())[:8]
    video_path  = TMP_DIR / f"{req.video_id}_{job_id}.%(ext)s"
    video_final = TMP_DIR / f"{req.video_id}_{job_id}.mp4"
    output_path = TMP_DIR / f"clip_{job_id}.mp4"

    last_error = ""

    try:
        # ── ダウンロード（複数クライアントでフォールバック）────────────────
        # クッキーファイルを明示的に取得・確認
        cf = _get_cookies_file()
        cookie_args = ["--cookies", str(cf)] if cf and cf.exists() else []

        base = [YT_DLP, "--no-warnings", "--no-check-certificates",
                "--ffmpeg-location", FFMPEG] + cookie_args

        download_strategies = [
            # 1. android + cookies + 最も互換性の高いフォーマット
            base + ["--extractor-args", "youtube:player_client=android",
                    "-f", "best[height<=720]/best",
                    "-o", str(video_path), "--no-playlist", "--", req.video_id],
            # 2. ios + cookies
            base + ["--extractor-args", "youtube:player_client=ios",
                    "-f", "best[height<=480]/best",
                    "-o", str(video_path), "--no-playlist", "--", req.video_id],
            # 3. クライアント指定なし + cookies
            base + ["-f", "best",
                    "-o", str(video_path), "--no-playlist", "--", req.video_id],
        ]

        dl_result = None
        for strategy in download_strategies:
            dl_result = subprocess.run(strategy, capture_output=True, text=True, timeout=300)
            if dl_result.returncode == 0:
                break
            last_error = dl_result.stderr

        if dl_result is None or dl_result.returncode != 0:
            raise HTTPException(500, f"[DEBUG] {last_error[-600:]}")

        # ダウンロードされたファイルを探す
        if not video_final.exists():
            matches = list(TMP_DIR.glob(f"{req.video_id}_{job_id}.*"))
            if not matches:
                raise HTTPException(500, "ダウンロードファイルが見つかりません")
            video_final = matches[0]

        # ── FFmpeg: 切り抜き ──────────────────────────────────────────────
        duration = req.end - req.start
        use_crop = req.mode == "crop"

        if req.format == "9:16":
            if use_crop:
                vf = "crop=ih*9/16:ih:(iw-ih*9/16)/2:0,scale=1080:1920:flags=lanczos"
            else:
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
        else:  # 16:9
            vf = "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1"

        ff = subprocess.run([
            FFMPEG, "-y",
            "-ss", str(req.start),
            "-i", str(video_final),
            "-t", str(duration),
            "-map", "0:v:0",
            "-map", "0:a:0",
            "-vf", vf,
            "-c:v", "libx264", "-crf", "22",
            "-c:a", "aac", "-b:a", "128k",
            "-preset", "fast",
            "-movflags", "+faststart",
            str(output_path),
        ], capture_output=True, text=True, timeout=300)

        if ff.returncode != 0:
            raise HTTPException(500, f"動画の生成に失敗しました: {ff.stderr[-400:]}")

        return FileResponse(
            str(output_path),
            media_type="video/mp4",
            filename=f"clip_{job_id}.mp4",
        )

    finally:
        # ソース動画を削除（クリップファイルはFileResponseが送信後に別途クリーンアップ）
        for f in TMP_DIR.glob(f"{req.video_id}_{job_id}.*"):
            try:
                f.unlink()
            except Exception:
                pass
