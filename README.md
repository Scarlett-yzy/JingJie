<p align="center">
  <h2 align="center">镜界 — AI 空间建模</h2>
  <p align="center">
    上传视频，AI 自动生成 3D 模型。<br>
    记录你到过的每个地方。
  </p>
</p>

<div align="center">
  <img src="./media/replica.gif" width="49%" /> 
  <img src="./media/wild.gif" width="49%" />
</div>

<p align="center">
<strong>镜界</strong> 是一款 AI 驱动的 3D 空间重建工具。

你只需用手机拍摄一段视频（室内空间、宿舍、办公室等），上传后即可自动生成 3D 点云模型，在浏览器中预览、下载 .glb 文件。
</p>

---

## 快速开始

### 环境配置

```bash
conda create -n slam3r python=3.11 cmake=3.14.0
conda activate slam3r
pip install torch==2.5.0 torchvision==0.20.0 torchaudio==2.5.0 --index-url https://download.pytorch.org/whl/cu118
pip install -r requirements.txt
pip install -r requirements_optional.txt
```

可选加速（推荐）：

```bash
pip install xformers==0.0.28.post2
cd slam3r/pos_embed/curope/ && python setup.py build_ext --inplace && cd ../../../
```

### 预训练权重

自动下载（运行 demo 时会自动拉取）：

```python
from slam3r.models import Image2PointsModel, Local2WorldModel
Image2PointsModel.from_pretrained('siyan824/slam3r_i2p')
Local2WorldModel.from_pretrained('siyan824/slam3r_l2w')
```

也可手动下载 `slam3r_i2p.pth` 和 `slam3r_l2w.pth` 放到 `checkpoints/` 目录。

### 启动 Web 服务

```bash
cd slam3r-server
uvicorn main:app --host 0.0.0.0 --port 8000
```

浏览器打开 `http://localhost:8000` 即可使用。

### 命令行重建

```bash
# Replica 数据集 demo
bash scripts/demo_replica.sh

# 自定义图片
bash scripts/demo_wild.sh

# 在线模式（视频/摄像头实时）
bash scripts/demo_wild.sh   # 取消注释 --online 参数
```

### Gradio 界面

```bash
# 离线模式
python app.py

# 在线模式（含 Viser 3D 实时预览）
python app.py --online
```

## 使用建议

- 视频时长 30 秒以内最佳，拿着手机匀速走一圈
- 确保光线充足，避免运动模糊
- 关键参数可配置 `KEYFRAME_STRIDE`、`CONF_THRES_I2P` 等（见 `scripts/demo_wild.sh`）

## 项目结构

```
slam3r/               — 核心重建引擎（模型、数据集、推理管线）
slam3r-server/        — FastAPI Web 后端 + 前端界面
  static/             — 前端页面（HTML/CSS/JS）
  main.py             — API 路由
  recon_worker.py     — 后台重建线程
  database.py         — 用户/模型数据库
scripts/              — 演示和评估脚本
checkpoints/          — 预训练权重
```

## 技术说明

本系统基于前馈神经网络，从单目 RGB 视频直接回归 3D 点云，无需显式相机参数估计。采用两阶段架构：

1. **Image-to-Points（I2P）** — 从滑动窗口帧预测局部 3D 点图
2. **Local-to-World（L2W）** — 将局部点图注册到全局世界坐标系

---

<p align="center">镜界 · 记录你到过的每个地方</p>
