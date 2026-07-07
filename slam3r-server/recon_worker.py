"""
重建工作线程
从 app_offline.py 的 recon_scene 改造而来：
- 去掉 Gradio 依赖
- 加入进度回调
- 按需加载模型，用完释放（6GB 显存不够同时放两个模型）
"""

import os
import sys
import shutil
import subprocess
import tempfile
import zipfile
import numpy as np
import torch
from os.path import join

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _find_ffmpeg() -> str:
    """查找系统上的 ffmpeg 可执行文件"""
    ffmpeg_path = shutil.which("ffmpeg")
    if ffmpeg_path:
        return ffmpeg_path
    # 常见安装路径兜底
    common_paths = [
        "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg",
        "/opt/homebrew/bin/ffmpeg",  # macOS (Apple Silicon)
        "/usr/local/opt/ffmpeg/bin/ffmpeg",  # macOS (Intel)
    ]
    for p in common_paths:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    raise RuntimeError(
        "❌ 服务器缺少 ffmpeg，无法从视频提取帧。\n"
        "\n"
        "请管理员在服务器上安装 ffmpeg：\n"
        "  Ubuntu/Debian:  sudo apt install ffmpeg\n"
        "  CentOS/RHEL:    sudo yum install ffmpeg\n"
        "  macOS:          brew install ffmpeg\n"
        "  Docker:         apt-get update && apt-get install -y ffmpeg\n"
        "\n"
        "或者改用图片序列进行重建（跳过视频提取步骤）。"
    )


def extract_frames(video_path: str, fps: float) -> str:
    """用 ffmpeg 提取视频帧到临时目录"""
    ffmpeg_bin = _find_ffmpeg()
    temp_dir = tempfile.mkdtemp()
    output_path = os.path.join(temp_dir, "%03d.jpg")
    command = [ffmpeg_bin, "-i", video_path, "-vf", f"fps={fps}", output_path]
    try:
        subprocess.run(command, check=True, capture_output=True)
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
        raise RuntimeError(
            f"ffmpeg 提取视频帧失败 (退出码 {e.returncode})。\n"
            f"命令: {' '.join(command)}\n"
            f"错误详情: {stderr[:500]}"
        ) from e
    return temp_dir


def extract_zip(zip_path: str) -> str:
    """解压 zip 文件到临时目录，返回图片目录路径"""
    import zipfile
    temp_dir = tempfile.mkdtemp()
    with zipfile.ZipFile(zip_path, 'r') as zf:
        zf.extractall(temp_dir)
    # 找到包含图片的目录（支持子目录或平铺）
    img_dir = temp_dir
    # 如果解压后只有一个子目录，那才是真正的图片目录
    items = os.listdir(temp_dir)
    if len(items) == 1 and os.path.isdir(os.path.join(temp_dir, items[0])):
        img_dir = os.path.join(temp_dir, items[0])
    return img_dir


def save_model_to_glb(per_frame_res, save_dir,
                      num_points_save=200000,
                      conf_thres_res=3):
    """把重建结果保存为 .glb 文件"""
    import trimesh
    from slam3r.utils.device import to_numpy

    pcds = []
    rgbs = []
    pred_frame_num = len(per_frame_res['l2w_pcds'])
    registered_confs = per_frame_res['l2w_confs']
    registered_pcds = per_frame_res['l2w_pcds']
    rgb_imgs = per_frame_res['rgb_imgs']
    for i in range(pred_frame_num):
        registered_pcd = to_numpy(registered_pcds[i])
        if registered_pcd.shape[0] == 3:
            registered_pcd = registered_pcd.transpose(1, 2, 0)
        registered_pcd = registered_pcd.reshape(-1, 3)
        rgb = rgb_imgs[i].reshape(-1, 3)
        pcds.append(registered_pcd)
        rgbs.append(rgb)

    res_pcds = np.concatenate(pcds, axis=0)
    res_rgbs = np.concatenate(rgbs, axis=0)
    pts_count = len(res_pcds)
    valid_ids = np.arange(pts_count)
    valid_masks = np.ones(pts_count, dtype=bool)

    if registered_confs is not None:
        conf_masks = []
        for i in range(len(registered_confs)):
            conf = registered_confs[i]
            conf_mask = (conf > conf_thres_res).reshape(-1).cpu()
            conf_masks.append(conf_mask)
        conf_masks = np.array(torch.cat(conf_masks))
        valid_ids = valid_ids[conf_masks & valid_masks]

    n_samples = min(num_points_save, len(valid_ids))
    if n_samples > 0:
        sampled_idx = np.random.choice(valid_ids, n_samples, replace=False)
    else:
        sampled_idx = valid_ids
    sampled_pts = res_pcds[sampled_idx]
    sampled_rgbs = res_rgbs[sampled_idx]
    sampled_pts[..., 1:] *= -1

    save_name = "recon.glb"
    scene = trimesh.Scene()
    scene.add_geometry(trimesh.PointCloud(vertices=sampled_pts, colors=sampled_rgbs / 255.))
    save_path = join(save_dir, save_name)
    scene.export(save_path)
    print(f"模型已保存: {save_path} ({len(sampled_pts)} 个点)")
    return save_path


def extract_frame_points(per_frame_res, rgb_imgs, frame_id, conf_thres=1.0, max_points=5000):
    """从单帧结果中提取点云（世界坐标），用于实时流推送。
    返回 (positions, colors) 或 (None, None)。
    """
    if frame_id >= len(per_frame_res['l2w_pcds']):
        return None, None
    pcd = per_frame_res['l2w_pcds'][frame_id]
    if pcd is None:
        return None, None

    from slam3r.utils.device import to_numpy as _to_np
    if isinstance(pcd, torch.Tensor):
        pcd = _to_np(pcd)
    if pcd.shape[0] == 3:
        pcd = pcd.transpose(1, 2, 0)
    pcd = pcd.reshape(-1, 3)

    # 颜色
    if frame_id < len(rgb_imgs):
        rgb = rgb_imgs[frame_id].reshape(-1, 3)
    else:
        return None, None

    # 置信度过滤
    conf = per_frame_res['l2w_confs'][frame_id]
    if conf is not None:
        if isinstance(conf, torch.Tensor):
            conf = _to_np(conf)
        conf = conf.reshape(-1)
        valid = conf > conf_thres
    else:
        valid = np.ones(len(pcd), dtype=bool)

    valid_pos = pcd[valid]
    valid_rgb = rgb[valid]

    if len(valid_pos) == 0:
        print(f"  [debug] 帧 {frame_id}: 置信度过滤后无点 (max conf={conf.max():.1f})")
        return None, None

    # 降采样
    n = min(max_points, len(valid_pos))
    idx = np.random.choice(len(valid_pos), n, replace=False)

    # Three.js 颜色用 0-1
    positions = valid_pos[idx].tolist()
    colors = (valid_rgb[idx] / 255.0).tolist()
    return positions, colors


def run_reconstruction(i2p_ckpt, l2w_ckpt, device,
                       video_path, save_dir, config,
                       input_type="video",
                       progress_callback=None,
                       stream_callback=None,
                       load_model_fn=None, unload_model_fn=None):
    """
    运行完整重建流程，按需加载模型（i2p 用完释放再加载 l2w）

    参数:
        i2p_ckpt: i2p 模型权重路径
        l2w_ckpt: l2w 模型权重路径
        device: cuda 或 cpu
        video_path: 输入视频/zip 路径
        save_dir: 结果保存目录
        input_type: "video" 或 "zip"
        config: 配置字典
        progress_callback(percent, message): 进度回调
        stream_callback(frame_id, total_frames, positions, colors):
            逐帧回调，用于实时推送点云到前端
            positions: [[x,y,z],...] 世界坐标列表
            colors: [[r,g,b],...] 颜色列表 (0-1)
        load_model_fn: 加载模型的函数
        unload_model_fn: 卸载模型的函数
    """
    def report(pct, msg):
        if progress_callback:
            progress_callback(pct, msg)

    fps = config.get("fps", 5)
    keyframe_stride = config.get("keyframe_stride", 3)
    initial_winsize = config.get("initial_winsize", 5)
    win_r = config.get("win_r", 3)
    conf_thres_i2p = config.get("conf_thres_i2p", 1.5)
    conf_thres_l2w = config.get("conf_thres_l2w", 12)
    num_scene_frame = config.get("num_scene_frame", 10)
    num_points_save = config.get("num_points_save", 1000000)
    update_buffer_intv = config.get("update_buffer_intv", 1)
    buffer_strategy = config.get("buffer_strategy", "reservoir")
    buffer_size = config.get("buffer_size", 100)

    from slam3r.models import Image2PointsModel, Local2WorldModel
    from slam3r.pipeline.recon_offline_pipeline import get_img_tokens, initialize_scene, adapt_keyframe_stride
    from slam3r.pipeline.recon_offline_pipeline import scene_frame_retrieve
    from slam3r.utils.recon_utils import i2p_inference_batch, l2w_inference, normalize_views, transform_img
    from slam3r.utils.device import to_device, to_numpy
    from slam3r.datasets.wild_seq import Seq_Data

    np.random.seed(42)

    # ════════════════════════════════════════════════════════
    # 阶段 1: 加载 i2p 模型，做编码 + I2P 重建
    # ════════════════════════════════════════════════════════
    report(2, "正在加载 AI 模型...")
    i2p_model = load_model_fn(Image2PointsModel, 'i2p', i2p_ckpt, device)

    # ── Step 1: 提取视频帧 / 解压图片 ──
    if input_type == "zip":
        report(5, "正在解压图片...")
        img_dir = extract_zip(video_path)
    else:
        report(5, "正在提取视频帧...")
        img_dir = extract_frames(video_path, fps)
    frame_files = sorted([f for f in os.listdir(img_dir) if f.endswith(('.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG'))])
    print(f"提取了 {len(frame_files)} 帧")

    # ── Step 2: 加载数据 ──
    report(8, "正在加载图像数据...")
    dataset = Seq_Data(img_dir, to_tensor=True)
    data_views = dataset[0][:]
    num_views = len(data_views)

    rgb_imgs = []
    for i in range(len(data_views)):
        if data_views[i]['img'].shape[0] == 1:
            data_views[i]['img'] = data_views[i]['img'][0]
        rgb_imgs.append(transform_img(dict(img=data_views[i]['img'][None]))[..., ::-1])

    for view in data_views:
        view['img'] = torch.tensor(view['img'][None]).to(device)
        view['true_shape'] = torch.tensor(view['true_shape'][None]).to(device)
        for key in ['valid_mask', 'pts3d_cam', 'pts3d']:
            if key in view:
                del view[key]

    # ── Step 3: 提取图像编码 ──
    report(12, "正在提取图像特征...")
    res_shapes, res_feats, res_poses = get_img_tokens(data_views, i2p_model)
    print('图像特征提取完成')

    input_views = []
    for i in range(num_views):
        input_views.append(dict(
            label=data_views[i]['label'],
            img_tokens=res_feats[i],
            true_shape=data_views[i]['true_shape'],
            img_pos=res_poses[i]
        ))

    # ── Step 4: 关键帧步长 ──
    if keyframe_stride == -1:
        kf_stride = adapt_keyframe_stride(input_views, i2p_model, win_r=3,
                                          adapt_min=1, adapt_max=20, adapt_stride=1)
    else:
        kf_stride = keyframe_stride

    # ── Step 5: 初始化场景 ──
    report(16, "正在初始化场景重建...")
    initial_winsize = min(initial_winsize, num_views // kf_stride)
    assert initial_winsize >= 2, "帧数不足，无法初始化场景重建"

    initial_pcds, initial_confs, init_ref_id = initialize_scene(
        input_views[:initial_winsize * kf_stride:kf_stride],
        i2p_model, winsize=initial_winsize, return_ref_id=True
    )

    init_num = len(initial_pcds)
    per_frame_res = dict(i2p_pcds=[], i2p_confs=[], l2w_pcds=[], l2w_confs=[])
    for key in per_frame_res:
        per_frame_res[key] = [None for _ in range(num_views)]

    registered_confs_mean = [_ for _ in range(num_views)]

    for i in range(init_num):
        per_frame_res['l2w_confs'][i * kf_stride] = initial_confs[i][0].to(device)
        registered_confs_mean[i * kf_stride] = per_frame_res['l2w_confs'][i * kf_stride].mean().cpu()

    buffering_set_ids = [i * kf_stride for i in range(init_num)]

    for i in range(init_num):
        input_views[i * kf_stride]['pts3d_world'] = initial_pcds[i]

    initial_valid_masks = [conf > conf_thres_i2p for conf in initial_confs]
    normed_pts = normalize_views(
        [view['pts3d_world'] for view in input_views[:init_num * kf_stride:kf_stride]],
        initial_valid_masks
    )
    for i in range(init_num):
        input_views[i * kf_stride]['pts3d_world'] = normed_pts[i]
        input_views[i * kf_stride]['pts3d_world'][~initial_valid_masks[i]] = 0
        per_frame_res['l2w_pcds'][i * kf_stride] = normed_pts[i]
    # 流推送: 初始窗口点云
    if stream_callback:
        all_pos, all_col = [], []
        for fid in buffering_set_ids:
            pos, col = extract_frame_points(per_frame_res, rgb_imgs, fid, conf_thres_i2p)
            if pos: all_pos.extend(pos); all_col.extend(col)
        if all_pos:
            stream_callback(frame_id=-1, total_frames=num_views, positions=all_pos, colors=all_col, is_initial=True)
            print(f"流推送: 初始窗口 {len(buffering_set_ids)} 帧, {len(all_pos)} 个点")

    # ── Step 6: I2P 重建（局部坐标） ──
    report(22, "正在分析画面深度...")
    local_confs_mean = []
    adj_distance = kf_stride

    for view_id in range(num_views):
        pct = 22 + int(38 * (view_id + 1) / num_views)
        report(pct, f"画面分析中: {view_id + 1}/{num_views}")

        if view_id in buffering_set_ids:
            if view_id // kf_stride == init_ref_id:
                per_frame_res['i2p_pcds'][view_id] = per_frame_res['l2w_pcds'][view_id].cpu()
            else:
                per_frame_res['i2p_pcds'][view_id] = torch.zeros_like(
                    per_frame_res['l2w_pcds'][view_id], device="cpu")
            per_frame_res['i2p_confs'][view_id] = per_frame_res['l2w_confs'][view_id].cpu()
            continue

        sel_ids = [view_id]
        for i in range(1, win_r + 1):
            if view_id - i * adj_distance >= 0:
                sel_ids.append(view_id - i * adj_distance)
            if view_id + i * adj_distance < num_views:
                sel_ids.append(view_id + i * adj_distance)
        local_views = [input_views[id] for id in sel_ids]

        output = i2p_inference_batch([local_views], i2p_model, ref_id=0,
                                     tocpu=False, unsqueeze=False)['preds']
        per_frame_res['i2p_pcds'][view_id] = output[0]['pts3d'].cpu()
        per_frame_res['i2p_confs'][view_id] = output[0]['conf'][0].cpu()

        input_views[view_id]['pts3d_cam'] = output[0]['pts3d']
        valid_mask = output[0]['conf'] > conf_thres_i2p
        input_views[view_id]['pts3d_cam'] = normalize_views(
            [input_views[view_id]['pts3d_cam']], [valid_mask])[0]
        input_views[view_id]['pts3d_cam'][~valid_mask] = 0

    local_confs_mean = [conf.mean() for conf in per_frame_res['i2p_confs']]
    print(f'I2P 重建完成，平均置信度: {torch.stack(local_confs_mean).mean():.2f}')

    # ── 保留 i2p 在 GPU，和 l2w 共存（总共 ~4GB，3060 的 6GB 够用）──
    # 注意: 之后 scene_frame_retrieve 需要 i2p 在 GPU 上处理数据

    # ════════════════════════════════════════════════════════
    # 阶段 2: 加载 l2w 模型，做全局注册
    # ════════════════════════════════════════════════════════
    report(62, "正在加载空间拼接模型...")
    l2w_model = load_model_fn(Local2WorldModel, 'l2w', l2w_ckpt, device)

    # ── Step 7: 注册初始窗口帧 ──
    report(65, "正在拼接初始帧...")
    if kf_stride > 1:
        max_conf_mean = -1
        for view_id in range((init_num - 1) * kf_stride):
            if view_id % kf_stride == 0:
                continue
            l2w_input_views = [input_views[view_id]] + [input_views[id] for id in buffering_set_ids]
            # 确保 pts3d_* 在 GPU 上
            for v in l2w_input_views:
                for k in ['pts3d_world', 'pts3d_cam']:
                    if k in v and isinstance(v[k], torch.Tensor) and v[k].device.type != 'cuda':
                        v[k] = v[k].to(device)
            output = l2w_inference(l2w_input_views, l2w_model,
                                   ref_ids=list(range(1, len(l2w_input_views))),
                                   device=device, normalize=False)
            input_views[view_id]['pts3d_world'] = output[0]['pts3d_in_other_view'].cpu()
            conf_map = output[0]['conf']
            per_frame_res['l2w_confs'][view_id] = conf_map[0].cpu()
            registered_confs_mean[view_id] = conf_map.mean().cpu()
            per_frame_res['l2w_pcds'][view_id] = input_views[view_id]['pts3d_world']

            if registered_confs_mean[view_id] > max_conf_mean:
                max_conf_mean = registered_confs_mean[view_id]

        # 流推送: 初始窗口非关键帧（不重复关键帧）
        if stream_callback:
            all_pos, all_col = [], []
            for _vid in range((init_num - 1) * kf_stride):
                if _vid % kf_stride == 0:
                    continue  # 关键帧已在 Hook 1 推送
                pos, col = extract_frame_points(per_frame_res, rgb_imgs, _vid, conf_thres_i2p)
                if pos: all_pos.extend(pos); all_col.extend(col)
            if all_pos:
                stream_callback(frame_id=-1, total_frames=num_views, positions=all_pos, colors=all_col, is_initial=False)
                print(f"流推送: 初始窗非关键帧 {len(all_pos)} 个点")

        max_initial_conf_mean = -1
        for i in range(init_num):
            if registered_confs_mean[i * kf_stride] > max_initial_conf_mean:
                max_initial_conf_mean = registered_confs_mean[i * kf_stride]
        factor = max_conf_mean / max_initial_conf_mean
        for i in range(init_num):
            per_frame_res['l2w_confs'][i * kf_stride] *= factor
            registered_confs_mean[i * kf_stride] = per_frame_res['l2w_confs'][i * kf_stride].mean().cpu()

    # ── Step 8: 全局拼接主循环 ──
    report(68, "正在拼接 3D 模型...")
    next_register_id = (init_num - 1) * kf_stride + 1
    milestone = (init_num - 1) * kf_stride + 1
    num_register = 1
    update_buffer_intv_actual = kf_stride * update_buffer_intv
    max_buffer_size = buffer_size
    strategy = buffer_strategy
    candi_frame_id = len(buffering_set_ids)
    l2w_total = num_views - next_register_id
    l2w_done = 0

    while next_register_id < num_views:
        ni = next_register_id
        max_id = min(ni + num_register, num_views) - 1

        cand_ref_ids = buffering_set_ids
        ref_views, sel_pool_ids = scene_frame_retrieve(
            [input_views[i] for i in cand_ref_ids],
            input_views[ni:ni + num_register:2],
            i2p_model, sel_num=num_scene_frame, depth=2)

        l2w_input_views = ref_views + input_views[ni:max_id + 1]
        input_view_num = len(ref_views) + max_id - ni + 1
        assert input_view_num == len(l2w_input_views)

        ref_ids = list(range(len(ref_views)))
        # l2w_inference 内部不会自动移动 pts3d_* 到 GPU，手动处理
        for v in l2w_input_views:
            for k in ['pts3d_world', 'pts3d_cam']:
                if k in v and isinstance(v[k], torch.Tensor) and v[k].device.type != 'cuda':
                    v[k] = v[k].to(device)
        output = l2w_inference(l2w_input_views, l2w_model,
                               ref_ids=ref_ids,
                               device=device, normalize=False)

        src_ids_local = [id + len(ref_views) for id in range(max_id - ni + 1)]
        src_ids_global = [id for id in range(ni, max_id + 1)]
        succ_num = 0
        for id in range(len(src_ids_global)):
            output_id = src_ids_local[id]
            view_id = src_ids_global[id]
            conf_map = output[output_id]['conf']
            input_views[view_id]['pts3d_world'] = output[output_id]['pts3d_in_other_view'].cpu()
            per_frame_res['l2w_confs'][view_id] = conf_map[0].cpu()
            registered_confs_mean[view_id] = conf_map[0].mean().cpu()
            per_frame_res['l2w_pcds'][view_id] = input_views[view_id]['pts3d_world']
            # 流推送: 每帧注册后实时推送
            if stream_callback:
                pos, col = extract_frame_points(per_frame_res, rgb_imgs, view_id, conf_thres_i2p)
                if pos:
                    stream_callback(frame_id=view_id, total_frames=num_views, positions=pos, colors=col, is_initial=False)
                    if view_id % 10 == 0:
                        print(f"流推送: 帧 {view_id}: {len(pos)} 个点")
            succ_num += 1

        next_register_id += succ_num
        l2w_done += succ_num
        if l2w_total > 0:
            pct = 68 + int(27 * min(l2w_done, l2w_total) / l2w_total)
            report(pct, f"模型拼接中: {min(l2w_done, l2w_total)}/{l2w_total}")

        # update buffering set
        if next_register_id - milestone >= update_buffer_intv_actual:
            while next_register_id - milestone >= kf_stride:
                candi_frame_id += 1
                full_flag = max_buffer_size > 0 and len(buffering_set_ids) >= max_buffer_size
                insert_flag = (not full_flag) or (
                    (strategy == 'fifo') or
                    (strategy == 'reservoir' and np.random.rand() < max_buffer_size / candi_frame_id)
                )
                if not insert_flag:
                    milestone += kf_stride
                    continue
                start_ids_offset = max(0, buffering_set_ids[-1] + kf_stride * 3 // 4 - milestone)
                mean_cand_recon_confs = torch.stack([
                    registered_confs_mean[i]
                    for i in range(milestone + start_ids_offset, milestone + kf_stride)
                ])
                mean_cand_local_confs = torch.stack([
                    local_confs_mean[i]
                    for i in range(milestone + start_ids_offset, milestone + kf_stride)
                ])
                mean_cand_recon_confs = (mean_cand_recon_confs - 1) / mean_cand_recon_confs
                mean_cand_local_confs = (mean_cand_local_confs - 1) / mean_cand_local_confs
                mean_cand_confs = mean_cand_recon_confs * mean_cand_local_confs
                most_conf_id = mean_cand_confs.argmax().item()
                most_conf_id += start_ids_offset
                id_to_buffer = milestone + most_conf_id
                buffering_set_ids.append(id_to_buffer)
                if full_flag:
                    if strategy == 'reservoir':
                        buffering_set_ids.pop(np.random.randint(max_buffer_size))
                    elif strategy == 'fifo':
                        buffering_set_ids.pop(0)
                milestone += kf_stride

        # input_views 保持在 CPU（l2w_inference 内部会自己处理 GPU 传输）
        # 不移到 GPU 以免显存溢出

    # 卸载 l2w 模型
    unload_model_fn(l2w_model)
    l2w_model = None

    # ── Step 9: 保存结果 ──
    report(96, "正在保存 3D 模型...")
    per_frame_res['rgb_imgs'] = rgb_imgs

    save_path = save_model_to_glb(
        per_frame_res=per_frame_res,
        save_dir=save_dir,
        num_points_save=num_points_save,
        conf_thres_res=conf_thres_l2w,
    )

    # ── Step 9b: 生成缩略图（从第一帧） ──
    try:
        frame_files = sorted([f for f in os.listdir(img_dir) if f.endswith('.jpg')])
        if frame_files:
            thumb_src = os.path.join(img_dir, frame_files[0])
            thumb_dst = os.path.join(save_dir, "thumbnail.jpg")
            shutil.copy2(thumb_src, thumb_dst)
            print(f"缩略图已生成: {thumb_dst}")
    except Exception as e:
        print(f"缩略图生成失败（不影响主结果）: {e}")

    try:
        shutil.rmtree(img_dir, ignore_errors=True)
    except Exception:
        pass

    # 清理中间数据
    del per_frame_res, input_views, rgb_imgs
    torch.cuda.empty_cache()

    print(f"重建完成！结果: {save_path}")
    return save_path
