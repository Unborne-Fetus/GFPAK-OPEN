/** Three.js model stage: real-time 3D preview, geometry stats, and clip playback. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { configureTextureSampling } from './texture-quality.js';

export class ModelStage {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 10000);
    this.camera.position.set(5, 3.4, 6);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(Math.max(container.clientWidth, 300), Math.max(container.clientHeight, 300));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.append(this.renderer.domElement);
    // Three.js sets a fixed pixel size on canvas during initial setup.
    // Keep CSS dimensions fluid while resize() controls the drawing buffer.
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.minDistance = 0.01;
    this.controls.maxDistance = 20000;
    this.controls.target.set(0, 1, 0);
    this.userAdjustedCamera = false;
    this.controls.addEventListener('start', () => { this.userAdjustedCamera = true; });

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x858585, 2.2));
    const key = new THREE.DirectionalLight(0xfff6e7, 3.5);
    key.position.set(6, 12, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = key.shadow.camera.bottom = -20;
    key.shadow.camera.right = key.shadow.camera.top = 20;
    key.shadow.bias = -0.0003;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 1.5);
    fill.position.set(-6, 6, -5);
    this.scene.add(fill);

    this.floor = new THREE.GridHelper(20, 24, 0x4a9b9b, 0x2c5468);
    this.floor.position.y = -0.015;
    this.floor.material.transparent = true;
    this.floor.material.opacity = 0.4;
    this.scene.add(this.floor);
    this.axes = new THREE.AxesHelper(2.5);
    this.axes.visible = false;
    this.scene.add(this.axes);

    this.root = null;
    this.mixer = null;
    this.animations = [];
    this.currentAction = null;
    this.playing = false;
    this.clock = new THREE.Clock();
    this.frameBounds = { radius: 2.5, target: new THREE.Vector3(0, 1, 0) };
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resizeObserver.observe(container.parentElement);
    this.viewportWidth = 0;
    this.viewportHeight = 0;
    this.onWindowResize = () => this.resize();
    window.addEventListener('resize', this.onWindowResize);
    document.addEventListener('fullscreenchange', this.onWindowResize);
    this.loop = this.loop.bind(this);
    this.animationId = requestAnimationFrame(this.loop);
    this.resize();
  }

  resize() {
    // Measure the actual on-screen canvas, not stale dimensions from the first render.
    const rect = this.container.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width < 2 || height < 2) return;
    if (width === this.viewportWidth && height === this.viewportHeight) return;
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // When the viewport changes shape substantially, reframe rather than
    // leaving the model off-center or cropped in a fullscreen/ultrawide view.
    if (this.root && !this.userAdjustedCamera) this.frame();
  }

  setModel(root, animations = []) {
    this.clear();
    this.root = root;
    this.animations = animations;
    root.traverse(obj => {
      if(obj.isMesh){obj.castShadow=true;obj.receiveShadow=true;}
    });
    this.refreshTextures();
    this.scene.add(root);
    const bounds = new THREE.Box3().setFromObject(root);
    const center = bounds.getCenter(new THREE.Vector3());
    const bottom = bounds.min.y;
    if (!bounds.isEmpty()) {
      root.position.x -= center.x;
      root.position.y -= bottom;
      root.position.z -= center.z;
    }
    this.setAnimations(animations);
    this.userAdjustedCamera = false;
    this.frame();
  }

  /** Native model textures arrive after geometry's first frame.
   * Reapply the desktop viewer's max supported anisotropy and mipmapping when
   * those BNTX/DDS images finish loading, without resetting camera/animation.
   */
  refreshTextures() {
    if(!this.root)return;
    const seen=new Set();
    const max=this.renderer.capabilities.getMaxAnisotropy();
    this.root.traverse(mesh=>{
      if(!mesh.isMesh)return;
      for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
        if(!material)return;
        for(const value of Object.values(material)){
          if(value?.isTexture&&!seen.has(value)){
            seen.add(value);configureTextureSampling(value,max);
          }
        }
      }
    });
  }

  setAnimations(animations = []) {
    // Attach deferred clips without removing or reframing the existing
    // visible mesh. Preserve the camera angle the user already adjusted.
    if (this.mixer && this.root) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.root);
    }
    this.animations = animations;
    this.mixer = this.root && animations.length
      ? new THREE.AnimationMixer(this.root) : null;
    this.currentAction = null;
    this.playing = false;
    if (this.mixer) this.playAnimation(0);
  }

  playAnimation(index) {
    if (!this.mixer || !this.animations[index]) return false;
    this.mixer.stopAllAction();
    const clip = this.animations[index];
    this.currentAction = this.mixer.clipAction(clip);
    this.currentAction.reset().play();
    this.playing = true;
    return true;
  }

  toggleAnimation(index = 0) {
    if (!this.mixer) return false;
    if (!this.currentAction) return this.playAnimation(index);
    this.playing = !this.playing;
    this.currentAction.paused = !this.playing;
    return this.playing;
  }

  frame() {
    if (!this.root) {
      this.controls.target.set(0, 1, 0);
      this.camera.position.set(5, 3.4, 6);
      this.controls.update();
      return;
    }
    const box = new THREE.Box3().setFromObject(this.root);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z, 0.01) * 0.5;
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov);
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * this.camera.aspect);
    const minFov = Math.max(Math.min(verticalFov, horizontalFov), 0.1);
    const dist = (radius / Math.sin(minFov / 2)) * 1.27;
    this.camera.near = Math.max(dist / 10000, 0.0001);
    this.camera.far = Math.max(dist * 100, 100);
    this.camera.updateProjectionMatrix();
    this.camera.position.copy(center).add(new THREE.Vector3(0.85, 0.45, 1).normalize().multiplyScalar(dist));
    this.controls.target.copy(center);
    this.controls.minDistance = Math.max(radius * 0.2, 0.001);
    this.controls.maxDistance = Math.max(radius * 100, 100);
    this.floor.scale.setScalar(Math.max(radius / 4, 0.005));
    this.axes.scale.setScalar(Math.max(radius / 2, 0.005));
    this.controls.update();
    this.userAdjustedCamera = false;
  }

  clear() {
    if (!this.root) return;
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.root);
    }
    this.scene.remove(this.root);
    this.root = null;
    this.animations = [];
    this.currentAction = null;
    this.mixer = null;
    this.playing = false;
  }

  setGrid(value) { this.floor.visible = value; }
  setAxes(value) { this.axes.visible = value; }
  setSpin(value) { this.controls.autoRotate = value; this.controls.autoRotateSpeed = 1.4; }

  loop() {
    // Some embedded WebViews fail to deliver ResizeObserver notifications for
    // fullscreen/window transitions; keep projection and drawing buffer in sync.
    const w = Math.round(this.container.getBoundingClientRect().width);
    const h = Math.round(this.container.getBoundingClientRect().height);
    if (w !== this.viewportWidth || h !== this.viewportHeight) this.resize();
    const delta = Math.min(this.clock.getDelta(), 0.1);
    if (this.mixer && this.playing) this.mixer.update(delta);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.animationId = requestAnimationFrame(this.loop);
  }

  dispose() {
    cancelAnimationFrame(this.animationId);
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    document.removeEventListener('fullscreenchange', this.onWindowResize);
    this.controls.dispose();
    this.clear();
    this.renderer.dispose();
  }
}
