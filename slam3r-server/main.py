"""
SLAM3R Server — FastAPI 后端
将 SLAM3R 3D 重建封装为 Web API

用法:
    uvicorn main:app --host 0.0.0.0 --port 8000

API:
    POST /api/reconstruct    上传视频，返回任务 ID
    GET  /api/status/{id}    查询进度
    GET  /api/result/{id}    下载 .glb 模型文件
"""

import sys
import os
import io
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uuid
import json
import time
import shutil
import threading
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, Form, Header, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import torch
import json
import asyncio

from recon_worker import run_reconstruction
import database

# ── 请求模型 ──

class AuthRegisterBody(BaseModel):
    username: str
    password: str
    nickname: str = ""

class AuthLoginBody(BaseModel):
    username: str
    password: str

class AuthResetBody(BaseModel):
    username: str
    new_password: str


# ── 认证依赖 ──

def get_current_user(authorization: str = Header("")):
    """从 Authorization header 中验证 token，返回当前用户"""
    token = authorization.replace("Bearer ", "").strip()
    user = database.validate_token(token)
    if not user:
        raise HTTPException(401, "请先登录")
    return user

# ── 配置 ──
RESULT_DIR = Path(__file__).parent / "results"
RESULT_DIR.mkdir(exist_ok=True)
TEMP_DIR   = Path(__file__).parent / "temp_uploads"
TEMP_DIR.mkdir(exist_ok=True)

DEFAULT_CONFIG = {
    "keyframe_stride": 3,
    "initial_winsize": 5,
    "win_r": 3,
    "conf_thres_i2p": 1.5,
    "conf_thres_l2w": 12,
    "num_scene_frame": 10,
    "num_points_save": 200000,
    "fps": 5,
    "update_buffer_intv": 1,
    "buffer_strategy": "reservoir",
    "buffer_size": 100,
}

checkpoint_dir = str(Path(__file__).parent.parent / "checkpoints")

# ── 任务状态管理 ──
tasks: dict[str, dict] = {}
tasks_lock = threading.Lock()

# ── WebSocket 连接管理 ──
ws_connections: dict[str, list[WebSocket]] = {}
ws_lock = threading.Lock()

# ── FastAPI 应用 ──
app = FastAPI(title="SLAM3R 3D 重建服务")

# 用于线程→协程桥接的事件循环引用
_main_loop = None

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

static_dir = Path(__file__).parent / "static"
static_dir_css = static_dir / "css"
static_dir_js = static_dir / "js"
if static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


# ── 启动事件 ──
@app.on_event("startup")
async def on_startup():
    global _main_loop
    _main_loop = asyncio.get_running_loop()
    database.init_db()
    print(f"数据库已初始化 ({database.DB_PATH})")

    # 检查模型文件是否存在
    i2p_ckpt = os.path.join(checkpoint_dir, "slam3r_i2p.pth")
    l2w_ckpt = os.path.join(checkpoint_dir, "slam3r_l2w.pth")
    if not os.path.isfile(i2p_ckpt):
        print(f"⚠️ I2P 模型文件不存在: {i2p_ckpt}")
        print(f"   请将 slam3r_i2p.pth 放到 {checkpoint_dir}/ 目录")
    if not os.path.isfile(l2w_ckpt):
        print(f"⚠️ L2W 模型文件不存在: {l2w_ckpt}")
        print(f"   请将 slam3r_l2w.pth 放到 {checkpoint_dir}/ 目录")

    # 从数据库恢复 tasks 内存记录
    with tasks_lock:
        for m in database.get_all_models():
            tid = m["task_id"]
            glb_path = RESULT_DIR / tid / "recon.glb"
            tasks[tid] = {
                "id": tid,
                "status": "completed",
                "progress": 100,
                "message": "重建完成！",
                "video_name": m.get("original_filename", f"模型-{tid[:8]}"),
                "video_size_mb": m.get("video_size_mb", 0),
                "result_path": str(glb_path) if glb_path.exists() else None,
                "user_id": m.get("user_id", 0),
                "error": None,
                "created_at": 0,
            }
    print(f"已恢复 {len([t for t in tasks.values() if t['status']=='completed'])} 个已完成模型")


# ── 手动处理首页 ──
@app.get("/")
async def serve_index():
    from fastapi.responses import HTMLResponse
    index_path = static_dir / "index.html"
    if index_path.exists():
        return HTMLResponse(content=index_path.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>SLAM3R Server is running</h1>")


# ── 模型加载（按需，用完释放） ──
def load_model(model_class, model_name, checkpoint_path, device='cuda'):
    """加载单个模型到 GPU，返回模型实例"""
    import argparse
    from slam3r.models import inf

    if not os.path.isfile(checkpoint_path):
        raise FileNotFoundError(
            f"模型文件不存在: {checkpoint_path}\n"
            f"请将 {model_name} 的权重文件放到该路径，或修改 checkpoint_dir。"
        )
    torch.serialization.add_safe_globals([argparse.Namespace])
    print(f"加载 {model_name}...")
    model = model_class(
        pos_embed='RoPE100', img_size=(224, 224), head_type='linear', output_mode='pts3d',
        depth_mode=('exp', -inf, inf), conf_mode=('exp', 1, inf),
        enc_embed_dim=1024, enc_depth=24, enc_num_heads=16, dec_embed_dim=768, dec_depth=12, dec_num_heads=12,
        mv_dec1='MultiviewDecoderBlock_max', mv_dec2='MultiviewDecoderBlock_max', enc_minibatch=11,
        **(dict(need_encoder=False) if model_name == 'l2w' else {})
    )
    ckpt = torch.load(checkpoint_path, map_location='cpu', weights_only=False)
    model.load_state_dict(ckpt['model'], strict=False)
    model.to(device)
    model.eval()
    print(f"{model_name} 加载完成")
    return model


def unload_model(model):
    """从 GPU 卸载模型，释放显存"""
    if model is not None:
        model.cpu()
        del model
    torch.cuda.empty_cache()


# ── API 接口 ──

# ── 用户认证 API ──

@app.get("/api/auth/check/{username}")
async def auth_check_username(username: str):
    """检查用户名是否存在，返回头像 URL"""
    user = database.check_username(username)
    if user:
        has_avatar = bool(user.get("avatar_path"))
        return {
            "exists": True,
            "avatar_url": f"/api/avatars/{user['id']}?t={int(time.time())}" if has_avatar else None,
            "username": user["username"],
        }
    return {"exists": False, "avatar_url": None}


@app.post("/api/auth/register")
async def auth_register(body: AuthRegisterBody):
    """注册新用户"""
    nickname = body.nickname.strip() or body.username
    try:
        user = database.register_user(body.username, body.password, nickname)
        return {"status": "ok", "message": "注册成功，请登录"}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/auth/login")
async def auth_login(body: AuthLoginBody):
    """用户登录"""
    try:
        user = database.login_user(body.username, body.password)
        has_avatar = bool(user.get("avatar_path"))
        return {
            "status": "ok",
            "token": user.get("token", ""),
            "user": {
                "id": user["id"],
                "username": user["username"],
                "nickname": user.get("nickname") or user["username"],
                "avatar_url": f"/api/avatars/{user['id']}?t={int(time.time())}" if has_avatar else None,
            }
        }
    except ValueError as e:
        raise HTTPException(401, str(e))


@app.post("/api/auth/reset")
async def auth_reset(body: AuthResetBody):
    """重置密码（无需旧密码，直接设新密码）"""
    try:
        result = database.reset_password(body.username, body.new_password)
        return {"status": "ok", "message": result["message"]}
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/auth/avatar/upload")
async def upload_avatar_file(
    user_id: int = Form(...),
    avatar: UploadFile = File(...),
):
    """上传用户头像（multipart/form-data）"""
    if not avatar.content_type or not avatar.content_type.startswith("image/"):
        raise HTTPException(400, "请上传图片文件")

    # 保存头像
    avatar_dir = RESULT_DIR.parent / "avatars"
    avatar_dir.mkdir(parents=True, exist_ok=True)
    ext = os.path.splitext(avatar.filename or "avatar.jpg")[1] or ".jpg"
    avatar_filename = f"user_{user_id}{ext}"
    avatar_path = avatar_dir / avatar_filename

    content = await avatar.read()
    with open(avatar_path, "wb") as f:
        f.write(content)

    # 更新数据库
    database.update_avatar(user_id, str(avatar_path))

    return {"status": "ok", "avatar_url": f"/api/avatars/{user_id}?t={int(time.time())}"}


@app.get("/api/avatars/{user_id}")
async def get_avatar(user_id: int):
    """获取用户头像"""
    avatar_dir = RESULT_DIR.parent / "avatars"
    for f in avatar_dir.glob(f"user_{user_id}.*"):
        return FileResponse(str(f), media_type=f"image/{f.suffix.lstrip('.')}")
    # 返回默认头像
    raise HTTPException(404, "头像未找到")


# ── 重建 API ──

ALLOWED_VIDEO_EXTS = ('.mp4', '.avi', '.mov', '.mkv', '.webm')
ALLOWED_ZIP_EXTS = ('.zip',)

@app.post("/api/reconstruct")
async def reconstruct(video: UploadFile = File(...), user: dict = Depends(get_current_user)):
    if not video.filename:
        raise HTTPException(400, "请选择一个文件")

    ext = os.path.splitext(video.filename)[1].lower()
    if ext in ALLOWED_ZIP_EXTS:
        input_type = "zip"
    elif ext in ALLOWED_VIDEO_EXTS:
        input_type = "video"
    else:
        raise HTTPException(400, "请上传视频文件（mp4/avi/mov/mkv/webm）或照片压缩包（zip）")

    # 限制文件大小（最大 500MB）
    MAX_FILE_SIZE = 500 * 1024 * 1024

    # 检查当前用户模型数量上限
    user_count = database.count_models(user["id"])
    if user_count >= database.MAX_MODELS_PER_USER:
        raise HTTPException(400, f"你的模型数量已达上限（{database.MAX_MODELS_PER_USER} 个），请删除旧的模型再创建新的")

    task_id = str(uuid.uuid4())[:8]
    video_ext = os.path.splitext(video.filename)[1] or ".mp4"
    video_path = TEMP_DIR / f"{task_id}{video_ext}"
    with open(video_path, "wb") as f:
        content = await video.read()
        f.write(content)

    video_size_mb = len(content) / (1024 * 1024)
    user_id = user["id"]

    with tasks_lock:
        tasks[task_id] = {
            "id": task_id,
            "user_id": user_id,
            "status": "queued",
            "progress": 0,
            "message": "等待处理...",
            "video_name": video.filename,
            "video_size_mb": round(video_size_mb, 1),
            "result_path": None,
            "error": None,
            "created_at": time.time(),
        }

    thread = threading.Thread(
        target=_process_task,
        args=(task_id, str(video_path), user_id, input_type),
        daemon=True,
    )
    thread.start()

    return {"task_id": task_id, "status": "queued", "message": "任务已创建", "input_type": input_type}


@app.get("/api/status/{task_id}")
async def get_status(task_id: str):
    task = tasks.get(task_id)
    if task is None:
        raise HTTPException(404, "任务不存在")
    return {
        "task_id": task_id,
        "status": task["status"],
        "progress": task["progress"],
        "message": task["message"],
        "video_name": task["video_name"],
        "video_size_mb": task.get("video_size_mb"),
        "error": task.get("error"),
    }


@app.get("/api/result/{task_id}")
async def download_result(task_id: str):
    task = tasks.get(task_id)
    result_path = None
    if task and task["status"] == "completed":
        result_path = task.get("result_path")

    # 如果内存中找不到或路径无效，直接从文件系统查找
    if not result_path or not os.path.exists(result_path):
        fallback = RESULT_DIR / task_id / "recon.glb"
        if fallback.exists():
            result_path = str(fallback)
        else:
            raise HTTPException(404, "结果文件未找到")

    filename = f"dorm3d_{task_id}.glb"
    return FileResponse(result_path, media_type="application/octet-stream", filename=filename)


@app.get("/api/tasks")
async def list_tasks():
    with tasks_lock:
        return {
            tid: {"status": info["status"], "progress": info["progress"],
                  "message": info["message"], "video_name": info.get("video_name")}
            for tid, info in tasks.items()
        }



# ── WebSocket 流式推送 ──

async def ws_send_json(ws: WebSocket, data: dict):
    """安全地发送 JSON 到 WebSocket"""
    try:
        await ws.send_json(data)
    except Exception:
        pass


async def ws_stream_callback(task_id: str, frame_id: int, total_frames: int,
                              positions: list, colors: list, is_initial: bool):
    """将逐帧点云推送到前端 WebSocket"""
    with ws_lock:
        conns = ws_connections.get(task_id, []).copy()
    if not conns:
        return
    msg = {
        "type": "points",
        "frame_id": frame_id,
        "total_frames": total_frames,
        "positions": positions,
        "colors": colors,
        "is_initial": is_initial,
    }
    for ws in conns:
        await ws_send_json(ws, msg)


@app.websocket("/ws/{task_id}")
async def websocket_endpoint(ws: WebSocket, task_id: str):
    await ws.accept()
    with ws_lock:
        ws_connections.setdefault(task_id, []).append(ws)
    print(f"WebSocket 已连接: task={task_id}")
    try:
        while True:
            # 保持连接，等待客户端 ping
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        with ws_lock:
            if task_id in ws_connections:
                ws_connections[task_id] = [w for w in ws_connections[task_id] if w != ws]
        print(f"WebSocket 已断开: task={task_id}")


# ── 新增: 模型管理 API ──


@app.get("/api/models")
async def list_models(user: dict = Depends(get_current_user)):
    """获取当前用户的所有模型列表"""
    models = database.get_user_models(user["id"])
    result = []
    for m in models:
        task_id = m["task_id"]
        glb_path = RESULT_DIR / task_id / "recon.glb"
        has_thumbnail = (RESULT_DIR / task_id / "thumbnail.jpg").exists()
        file_size = glb_path.stat().st_size if glb_path.exists() else 0
        result.append({
            **m,
            "created_at": _fmt_time(m["created_at"]),
            "file_size_bytes": file_size,
            "has_thumbnail": has_thumbnail,
            "thumbnail_url": f"/api/models/{task_id}/thumbnail" if has_thumbnail else None,
        })
    return result


@app.get("/api/models/{task_id}")
async def get_model_detail(task_id: str, user: dict = Depends(get_current_user)):
    """获取单个模型详情"""
    model = database.get_model(task_id)
    if model is None:
        raise HTTPException(404, "模型不存在")
    glb_path = RESULT_DIR / task_id / "recon.glb"
    has_thumbnail = (RESULT_DIR / task_id / "thumbnail.jpg").exists()
    file_size = glb_path.stat().st_size if glb_path.exists() else 0
    return {
        **model,
        "created_at": _fmt_time(model["created_at"]),
        "file_size_bytes": file_size,
        "has_thumbnail": has_thumbnail,
        "thumbnail_url": f"/api/models/{task_id}/thumbnail" if has_thumbnail else None,
        "glb_url": f"/api/result/{task_id}",
    }


@app.put("/api/models/{task_id}/notes")
async def update_model_notes(task_id: str, body: dict, user: dict = Depends(get_current_user)):
    """更新模型备注"""
    model = database.get_model(task_id)
    if model is None:
        raise HTTPException(404, "模型不存在")
    notes = body.get("notes", "")
    database.update_notes(task_id, notes)
    return {"status": "ok"}


@app.put("/api/models/{task_id}/name")
async def update_model_name(task_id: str, body: dict, user: dict = Depends(get_current_user)):
    """更新模型显示名称"""
    model = database.get_model(task_id)
    if model is None:
        raise HTTPException(404, "模型不存在")
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(400, "名称不能为空")
    database.update_name(task_id, name)
    return {"status": "ok"}


@app.delete("/api/models/{task_id}")
async def delete_model(task_id: str, user: dict = Depends(get_current_user)):
    """删除模型（数据库记录 + 物理文件）"""
    model = database.get_model(task_id)
    if model is None:
        raise HTTPException(404, "模型不存在")
    task_dir = RESULT_DIR / task_id
    if task_dir.exists():
        shutil.rmtree(str(task_dir), ignore_errors=True)
    database.delete_model(task_id)
    with tasks_lock:
        tasks.pop(task_id, None)
    return {"status": "ok", "message": f"模型 {task_id} 已删除"}


@app.get("/api/models/{task_id}/thumbnail")
async def get_thumbnail(task_id: str):
    """返回模型缩略图"""
    thumb_path = RESULT_DIR / task_id / "thumbnail.jpg"
    if not thumb_path.exists():
        raise HTTPException(404, "缩略图未找到")
    return FileResponse(str(thumb_path), media_type="image/jpeg")


def _fmt_time(ts) -> str:
    """将数据库时间戳格式化为可读字符串"""
    if not ts:
        return ""
    try:
        from datetime import datetime
        # SQLite CURRENT_TIMESTAMP 返回 'YYYY-MM-DD HH:MM:SS'（空格分隔）
        # fromisoformat 在 Python 3.10 以下需要 T 分隔，统一替换
        dt = datetime.fromisoformat(ts.replace(' ', 'T')) if isinstance(ts, str) else ts
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(ts)[:16] if ts else ""


# ── 后台处理 ──

def _progress_callback(task_id: str):
    def cb(percent: int, message: str):
        with tasks_lock:
            task = tasks.get(task_id)
            if task is not None:
                task["progress"] = min(percent, 99)
                task["message"] = message
    return cb


def _make_stream_callback(task_id: str):
    """创建 sync stream_callback，从后台线程桥接到 async WebSocket"""
    def cb(frame_id, total_frames, positions, colors, is_initial=False):
        if positions and len(positions) > 0:
            print(f"流推送: task={task_id} frame={frame_id} points={len(positions)}")
        coro = ws_stream_callback(task_id, frame_id, total_frames, positions, colors, is_initial)
        try:
            if _main_loop is not None and _main_loop.is_running():
                asyncio.run_coroutine_threadsafe(coro, _main_loop)
            elif positions:
                print(f"流推送失败: _main_loop 未运行")
        except Exception as e:
            print(f"流推送异常: {e}")
    return cb


def _process_task(task_id: str, video_path: str, user_id: int = 0, input_type: str = "video"):
    with tasks_lock:
        task = tasks[task_id]
        task["status"] = "processing"
        task["message"] = "开始处理..."

    try:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        from slam3r.models import Image2PointsModel, Local2WorldModel

        result_dir = RESULT_DIR / task_id
        result_dir.mkdir(parents=True, exist_ok=True)

        glb_path = run_reconstruction(
            i2p_ckpt=os.path.join(checkpoint_dir, "slam3r_i2p.pth"),
            l2w_ckpt=os.path.join(checkpoint_dir, "slam3r_l2w.pth"),
            device=device,
            video_path=video_path,
            save_dir=str(result_dir),
            config=DEFAULT_CONFIG,
            input_type=input_type,
            progress_callback=_progress_callback(task_id),
            stream_callback=_make_stream_callback(task_id),
            load_model_fn=load_model,
            unload_model_fn=unload_model,
        )

        with tasks_lock:
            task = tasks[task_id]
            task["status"] = "completed"
            task["progress"] = 100
            task["message"] = "重建完成！"
            task["result_path"] = glb_path

        # 写入数据库持久化（带 user_id）
        try:
            database.add_model(
                task_id=task_id,
                filename=task.get("video_name", f"模型-{task_id}"),
                video_size_mb=task.get("video_size_mb", 0),
                user_id=user_id,
            )
        except Exception as db_err:
            print(f"写入数据库失败（不影响结果）: {db_err}")

        print(f"任务 {task_id} 完成: {glb_path}")

        try:
            if os.path.exists(video_path):
                os.remove(video_path)
        except Exception:
            pass

    except Exception as e:
        with tasks_lock:
            task = tasks.get(task_id)
            if task:
                task["status"] = "failed"
                task["message"] = f"处理失败: {str(e)}"
                task["error"] = str(e)
        print(f"任务 {task_id} 失败: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000,
                timeout_keep_alive=300,
                limit_concurrency=2)
