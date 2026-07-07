<p align="center">
  <img src="./media/logo.svg" width="80" height="80" alt="镜界" style="display:none;" />
  <h2 align="center">📷 镜界</h2>
  <p align="center"><strong>上传一段视频，AI 自动生成 3D 模型。</strong><br>记录你到过的每个地方。</p>
</p>

<p align="center">
  <img src="./media/replica.gif" width="49%" alt="室内部景" />
  <img src="./media/wild.gif" width="49%" alt="室外场景" />
</p>

## 这是什么

**镜界** 是一个开箱即用的 3D 空间重建 Web 应用。

你只需要用手机拍一段视频（宿舍、办公室、客厅等），上传后就能自动生成 3D 点云模型，在浏览器里拖拽旋转预览，或导出 `.glb` 文件保存。

> 它基于 **SLAM3R**（CVPR 2025 Highlight）论文成果构建，在其研究模型之上封装了完整的 Web 服务端和前端交互。

## 适合谁用

| 场景 | 说明 |
|------|------|
| 🏠 毕业生 | 拍下宿舍，毕业了还能「回去看看」 |
| 🏢 租房/装修 | 记录房间格局，后续对比参考 |
| 🎮 3D 爱好者 | 快速获取真实空间的点云数据 |
| 🔬 开发者 | 在自己的项目里集成 3D 重建能力 |

## 30 秒上手

```bash
# 1. 启动 Web 服务
cd slam3r-server
python -m uvicorn main:app --host 0.0.0.0 --port 8000

# 2. 浏览器打开 http://localhost:8000
# 3. 注册 → 上传视频 → 等待重建 → 预览 & 下载
```

## 功能一览

- **视频上传** — 拖拽或选择 mp4/mov/avi 文件
- **实时进度** — 进度条 + WebSocket 流式点云推送
- **3D 预览** — Three.js 在线查看器，支持旋转/缩放
- **模型管理** — 列表/重命名/备注/删除
- **用户系统** — 注册登录，模型按用户隔离
- **GLB 导出** — 下载标准 `.glb` 文件

## 技术栈

| 层 | 技术 |
|------|------|
| 前端 | HTML + CSS + Three.js（纯静态） |
| 后端 | Python FastAPI |
| 数据库 | SQLite |
| 重建引擎 | SLAM3R / DUSt3R 神经网络 |

## 快速部署

<details>
<summary><strong>完整环境搭建（点击展开）</strong></summary>

```bash
# 创建环境
conda create -n slam3r python=3.11 cmake=3.14.0
conda activate slam3r
pip install torch==2.5.0 torchvision==0.20.0 torchaudio==2.5.0 --index-url https://download.pytorch.org/whl/cu118
pip install -r requirements.txt

# 可选：加速
pip install xformers==0.0.28.post2
cd slam3r/pos_embed/curope/ && python setup.py build_ext --inplace && cd ../../../
```

预训练权重首次运行会自动下载。手动下载：
```python
from slam3r.models import Image2PointsModel, Local2WorldModel
Image2PointsModel.from_pretrained('siyan824/slam3r_i2p')
Local2WorldModel.from_pretrained('siyan824/slam3r_l2w')
```
</details>

## 项目结构

```
slam3r/               ← SLAM3R 重建引擎（模型、推理管线）
slam3r-server/        ← Web 应用层（镜界产品）
  static/              前端界面
  main.py              API 服务
  recon_worker.py      后台重建任务
  database.py          用户 / 模型存储
```

## 致谢

- [SLAM3R](https://github.com/PKU-VCL-3DV/SLAM3R) — CVPR 2025 Highlight 论文
- [DUSt3R](https://github.com/naver/dust3r) — 训练框架
- [CroCo](https://github.com/naver/croco) — 视觉预训练

---

<p align="center">镜界 · 记录你到过的每个地方</p>
