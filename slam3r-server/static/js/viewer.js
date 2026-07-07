/**
 * Three.js 3D 点云查看器
 * 加载 .glb 点云文件，支持鼠标旋转/缩放/自动旋转
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class PointCloudViewer {
    constructor(containerId, options = {}) {
        this.container = document.getElementById(containerId);
        if (!this.container) return;

        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.pointCloud = null;
        this.streamPoints = null;
        this.autoRotate = options.autoRotate !== false;
        this.bgColor = options.bgColor || 0x1a1a2e;
        this.animationId = null;

        this._init();
    }

    _init() {
        const rect = this.container.getBoundingClientRect();
        const width = rect.width || 720;
        const height = rect.height || 480;

        // 场景
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.bgColor);

        // 相机
        this.camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
        this.camera.position.set(2, 1.5, 3);
        this.camera.lookAt(0, 0, 0);

        // 渲染器（捕获 WebGL 创建失败）
        try {
            this.renderer = new THREE.WebGLRenderer({ antialias: true });
        } catch (e) {
            console.error('WebGL 创建失败:', e);
            this._showError('浏览器不支持 3D 渲染，请换个浏览器试试');
            return;
        }
        if (!this.renderer.capabilities || !this.renderer.capabilities.isWebGL2) {
            console.warn('WebGL 不可用');
        }
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.container.appendChild(this.renderer.domElement);

        // 控制器
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.autoRotate = true;
        this.controls.autoRotateSpeed = 2.0;
        this.controls.minDistance = 0.5;
        this.controls.maxDistance = 20;
        this.controls.target.set(0, 0, 0);

        // 环境光
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
        dirLight.position.set(5, 10, 7);
        this.scene.add(dirLight);

        const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
        dirLight2.position.set(-5, -3, -5);
        this.scene.add(dirLight2);

        // 网格辅助（可选，帮助理解空间）
        const gridHelper = new THREE.GridHelper(4, 20, 0x444466, 0x333355);
        gridHelper.position.y = -1;
        this.scene.add(gridHelper);

        // 窗口 resize
        this._onResize = this._onResize.bind(this);
        window.addEventListener('resize', this._onResize);

        // 开始渲染循环
        this._animate();
    }

    _onResize() {
        if (!this.renderer) return;
        const rect = this.container.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;
        if (width > 0 && height > 0) {
            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(width, height);
        }
    }

    _showError(msg) {
        const el = document.createElement('div');
        el.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#999;font-size:14px;text-align:center;padding:20px';
        el.textContent = msg;
        this.container.appendChild(el);
    }

    _animate() {
        this.animationId = requestAnimationFrame(() => this._animate());
        this.controls.update();
        if (this.renderer) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    /**
     * 加载 .glb 模型文件
     */
    loadModel(url) {
        return new Promise((resolve, reject) => {
            const loader = new GLTFLoader();

            // 清除旧模型
            if (this.pointCloud) {
                this.scene.remove(this.pointCloud);
                this.pointCloud = null;
            }
            if (this.streamPoints) {
                this.scene.remove(this.streamPoints);
                this.streamPoints = null;
            }

            // 显示加载中
            const ph = this.container.querySelector('.viewer-placeholder');
            if (ph) ph.style.display = 'flex';

            loader.load(
                url,
                (gltf) => {
                    const model = gltf.scene;

                    // 遍历所有子物体，找到点云
                    model.traverse((child) => {
                        if (child.isMesh || child.isPoints) {
                            // 如果是点云，调整大小
                            const box = new THREE.Box3().setFromObject(child);
                            const size = box.getSize(new THREE.Vector3());
                            const maxDim = Math.max(size.x, size.y, size.z);

                            if (maxDim > 0) {
                                // 缩放到合适大小
                                const scale = 3.0 / maxDim;
                                child.scale.set(scale, scale, scale);
                            }

                            // 居中
                            const center = box.getCenter(new THREE.Vector3());
                            child.position.sub(center);
                        }
                    });

                    this.pointCloud = model;
                    this.scene.add(model);

                    // 重置相机视角
                    this.controls.target.set(0, 0, 0);
                    this.camera.position.set(2, 1.5, 3);
                    this.controls.update();

                    // 隐藏加载提示
                    const placeholder = this.container.querySelector('.viewer-placeholder');
                    if (placeholder) placeholder.style.display = 'none';

                    resolve(model);
                },
                (progress) => {
                    // 加载进度
                    if (progress.total > 0) {
                        const pct = Math.round((progress.loaded / progress.total) * 100);
                        const placeholder = this.container.querySelector('.viewer-placeholder span');
                        if (placeholder) placeholder.textContent = `加载模型中... ${pct}%`;
                    }
                },
                (error) => {
                    console.error('模型加载失败:', error);
                    const placeholder = this.container.querySelector('.viewer-placeholder');
                    if (placeholder) {
                        placeholder.innerHTML = '<span style="color:#ef4444;">❌ 模型加载失败</span>';
                    }
                    reject(error);
                }
            );
        });
    }

    /**
     * 从 ArrayBuffer 加载 .glb 数据
     */
    loadModelFromBuffer(buffer) {
        const blob = new Blob([buffer], { type: 'model/gltf-binary' });
        const url = URL.createObjectURL(blob);
        const promise = this.loadModel(url);
        // 加载完成后释放 URL
        promise.then(() => setTimeout(() => URL.revokeObjectURL(url), 1000));
        return promise;
    }

    /**
     * 增量添加点云（用于流式重建）
     * @param {Float32Array|number[][]} positions - [[x,y,z],...] 或扁平数组
     * @param {Float32Array|number[][]} colors - [[r,g,b],...] 或扁平数组 (0-1)
     */
    addPoints(positions, colors) {
        if (!positions || positions.length === 0) return;

        // 转换为扁平 Float32Array
        let posArray, colArray;
        if (Array.isArray(positions)) {
            posArray = new Float32Array(positions.flat());
        } else {
            posArray = positions;
        }
        if (Array.isArray(colors)) {
            colArray = new Float32Array(colors.flat());
        } else {
            colArray = colors;
        }

        // 计算当前这批点的包围盒（用于自适应）
        const batchBox = new THREE.Box3();
        for (let i = 0; i < posArray.length; i += 3) {
            batchBox.expandByPoint(new THREE.Vector3(posArray[i], posArray[i+1], posArray[i+2]));
        }

        // 如果已有 streaming point cloud，追加到同一个
        if (!this.streamPoints) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
            geo.setAttribute('color', new THREE.BufferAttribute(colArray, 3));

            // 点大小自适应
            const batchSize = batchBox.getSize(new THREE.Vector3());
            const batchMax = Math.max(batchSize.x, batchSize.y, batchSize.z);
            const pointSize = batchMax > 0 ? batchMax / 200 : 0.03;

            const mat = new THREE.PointsMaterial({
                size: Math.max(pointSize, 0.02),
                vertexColors: true,
                sizeAttenuation: true,
                opacity: 0.9,
                transparent: true,
            });
            this.streamPoints = new THREE.Points(geo, mat);
            this.scene.add(this.streamPoints);

            // 移动相机到可见范围
            const center = batchBox.getCenter(new THREE.Vector3());
            const dist = Math.max(batchMax * 0.8, 2);
            this.camera.position.set(center.x + dist, center.y + dist * 0.6, center.z + dist);
            this.controls.target.copy(center);
            this.controls.update();
        } else {
            const geo = this.streamPoints.geometry;
            const oldPos = geo.attributes.position.array;
            const oldCol = geo.attributes.color.array;

            const newPos = new Float32Array(oldPos.length + posArray.length);
            const newCol = new Float32Array(oldCol.length + colArray.length);
            newPos.set(oldPos);
            newPos.set(posArray, oldPos.length);
            newCol.set(oldCol);
            newCol.set(colArray, oldCol.length);

            geo.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
            geo.setAttribute('color', new THREE.BufferAttribute(newCol, 3));
            geo.attributes.position.needsUpdate = true;
            geo.attributes.color.needsUpdate = true;

            // 点大小自适应（取更大范围）
            const fullBox = new THREE.Box3().setFromObject(this.streamPoints);
            const fullSize = fullBox.getSize(new THREE.Vector3());
            const fullMax = Math.max(fullSize.x, fullSize.y, fullSize.z);
            if (fullMax > 0) {
                this.streamPoints.material.size = Math.max(fullMax / 200, 0.02);
            }

            // 平滑移动相机到新的中心
            const center = fullBox.getCenter(new THREE.Vector3());
            const dist = Math.max(fullMax * 0.8, 2);
            this.camera.position.lerp(
                new THREE.Vector3(center.x + dist, center.y + dist * 0.6, center.z + dist),
                0.3
            );
            this.controls.target.lerp(center, 0.3);
        }
    }
    dispose() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }
        window.removeEventListener('resize', this._onResize);
        if (this.streamPoints) {
            this.scene.remove(this.streamPoints);
            this.streamPoints.geometry.dispose();
            this.streamPoints = null;
        }
        if (this.renderer) {
            this.renderer.dispose();
        }
        if (this.container && this.renderer.domElement) {
            this.container.removeChild(this.renderer.domElement);
        }
    }
}
