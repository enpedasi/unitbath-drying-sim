import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { clothingPositions, DEPTH, DOOR_CENTER, DOOR_WIDTH, HEIGHT, exhaustOpening, fanDirection, isFluidSegment, roomWidth, sameGeometry, sampleVelocity, sampleVorticity } from '../simulation/model';
import type { FlowField, Settings } from '../simulation/model';
import { streamlineSeeds, traceStreamline } from './streamlines';
import { advanceParticle } from './particles';
import { flowVectors, particleSeed, particleSeedCells, uniformFlowSeeds, VECTOR_SPACING } from './sampling';
import { VectorMotion } from './vectorMotion';

export type View = 'quarter' | 'top' | 'front';
export type DisplayMode = 'vectors' | 'trails' | 'particles' | 'streamlines';
export type ColorMode = 'speed' | 'vorticity';
export interface SceneOptions { playing: boolean; speed: number; mode: DisplayMode; walls: boolean; flow: boolean; colorMode: ColorMode }
const BLUE = new THREE.Color('#168afa'), CYAN = new THREE.Color('#16c9c2'), WARM = new THREE.Color('#f4b44e');
export function flowColor(speed: number, target = new THREE.Color()) {
  const t = Math.min(speed / 0.8, 1);
  return t < 0.45 ? target.copy(BLUE).lerp(CYAN, t / 0.45) : target.copy(CYAN).lerp(WARM, (t - 0.45) / 0.55);
}
function disposeGroup(group: THREE.Object3D) {
  group.traverse(child => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    if (mesh.material) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.dispose();
  });
  group.clear();
}

export class SceneEngine {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
  controls: OrbitControls;
  architecture = new THREE.Group();
  ghosts: THREE.Object3D[] = [];
  rotor = new THREE.Group();
  field: FlowField | null = null;
  settings: Settings;
  options: SceneOptions = { playing: true, speed: 1, mode: 'vectors', walls: true, flow: true, colorMode: 'speed' };
  private frame = 0;
  private lastTime = 0;
  private elapsed = 0;
  private disposed = false;
  private resize: ResizeObserver;
  private count = 520;
  private trailLength = 48;
  private historyTime = 0;
  private incomingRate = 1;
  private particles: Float32Array;
  private ages: Float32Array;
  private exitAges: Float32Array;
  private history: Float32Array;
  private linePositions: Float32Array;
  private lineColors: Float32Array;
  private pointColors: Float32Array;
  private lines: THREE.LineSegments;
  private streamlines: THREE.LineSegments;
  private streamlinesDirty = true;
  private nextStreamlineUpdate = 0;
  private vectors: THREE.LineSegments;
  private vectorGuides: THREE.LineSegments;
  private vectorPoints: THREE.Points;
  private vectorMotion = new VectorMotion();
  private vectorsDirty = true;
  private nextVectorUpdate = 0;
  private seedCells: number[] = [];
  private points: THREE.Points;
  private vec = [0, 0, 0];
  private color = new THREE.Color();
  private labelNodes: Map<string, HTMLElement>;
  onTick?: (elapsed: number) => void;
  onAdvance?: (dt: number) => void;
  private nextTick = 0;
  constructor(private host: HTMLElement, settings: Settings, labels: Map<string, HTMLElement>) {
    this.settings = settings; this.labelNodes = labels;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor('#f4f7fa', 0);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;
    this.renderer.domElement.setAttribute('aria-label', 'ユニットバスの3Dシミュレーション。ドラッグで回転、スクロールで拡大縮小');
    this.renderer.domElement.setAttribute('role', 'img');
    host.prepend(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.085;
    this.controls.minZoom = 0.55; this.controls.maxZoom = 3;
    this.controls.minPolarAngle = 0.001; this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.scene.add(new THREE.HemisphereLight('#edf7ff', '#c4c2b8', 2.7));
    const sun = new THREE.DirectionalLight('#ffffff', 4);
    sun.position.set(-3, 8, 6); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.1, far: 20 });
    sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.025;
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight('#d8eaff', 1.3); fill.position.set(4, 4, -3); this.scene.add(fill);
    this.scene.add(this.architecture);
    this.particles = new Float32Array(this.count * 3); this.ages = new Float32Array(this.count);
    this.exitAges = new Float32Array(this.count).fill(-1);
    this.history = new Float32Array(this.count * this.trailLength * 3);
    this.linePositions = new Float32Array(this.count * (this.trailLength - 1) * 6);
    this.lineColors = new Float32Array(this.linePositions.length); this.pointColors = new Float32Array(this.particles.length);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3).setUsage(THREE.DynamicDrawUsage));
    lineGeometry.setAttribute('color', new THREE.BufferAttribute(this.lineColors, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.68, depthWrite: false }));
    this.lines.frustumCulled = false; this.lines.visible = false;
    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute('position', new THREE.BufferAttribute(this.particles, 3).setUsage(THREE.DynamicDrawUsage));
    pointGeometry.setAttribute('color', new THREE.BufferAttribute(this.pointColors, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(pointGeometry, new THREE.PointsMaterial({ size: 0.024, vertexColors: true, transparent: true, opacity: 0.88, depthWrite: false }));
    this.points.frustumCulled = false; this.points.visible = false;
    this.streamlines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.76, depthWrite: false }));
    this.streamlines.frustumCulled = false; this.streamlines.visible = false;
    this.vectors = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
    this.vectorGuides = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.18, depthWrite: false }));
    this.vectorPoints = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 0.018, color: '#647991', transparent: true, opacity: 0.65, depthWrite: false }));
    this.vectors.frustumCulled = this.vectorGuides.frustumCulled = this.vectorPoints.frustumCulled = false;
    this.vectors.visible = this.vectorGuides.visible = this.vectorPoints.visible = false;
    this.scene.add(this.lines, this.points, this.streamlines, this.vectorGuides, this.vectors, this.vectorPoints);
    this.buildRoom(); this.setView('quarter');
    this.resize = new ResizeObserver(() => this.resizeCanvas()); this.resize.observe(host); this.resizeCanvas();
    this.animate(0);
  }
  private material(color: string, extra: THREE.MeshStandardMaterialParameters = {}) {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
  }
  private box(size: number[], position: number[], color: string, rounded = 0, parent: THREE.Object3D = this.architecture, extra: THREE.MeshStandardMaterialParameters = {}) {
    const geometry = rounded ? new RoundedBoxGeometry(size[0], size[1], size[2], 3, rounded) : new THREE.BoxGeometry(...size as [number, number, number]);
    const mesh = new THREE.Mesh(geometry, this.material(color, extra));
    mesh.position.set(...position as [number, number, number]); mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  private rod(a: number[], b: number[], radius: number, color: string, parent: THREE.Object3D = this.architecture) {
    const start = new THREE.Vector3(...a as [number, number, number]), end = new THREE.Vector3(...b as [number, number, number]), d = end.clone().sub(start);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, d.length(), 12), this.material(color, { metalness: 0.65, roughness: 0.27 }));
    mesh.position.copy(start.add(end).multiplyScalar(0.5)); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()); mesh.castShadow = true; parent.add(mesh); return mesh;
  }
  private line(a: number[], b: number[], color = '#d4dfe5', opacity = 1, parent: THREE.Object3D = this.architecture) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a as [number, number, number]), new THREE.Vector3(...b as [number, number, number])]);
    const mesh = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity })); parent.add(mesh); return mesh;
  }
  private buildRoom() {
    disposeGroup(this.architecture); this.ghosts = [];
    const w = roomWidth(this.settings.size), d = DEPTH, h = HEIGHT;
    const platformW = w + 1.45, platformD = 4.95;
    this.box([platformW, 0.17, platformD], [0.1, -0.19, 0.9], '#d6dce2', 0.05);
    this.box([platformW - 0.03, 0.05, platformD - 0.03], [0.1, -0.08, 0.9], '#e4d7c3', 0.025);
    for (let x = -platformW / 2 + 0.1; x < platformW / 2 + 0.1; x += 0.19) this.line([x, -0.051, -1.5], [x, -0.051, 3.36], '#c6b8a3', 0.42);
    this.box([w + 0.2, 0.12, d + 0.2], [0, 0, 0], '#dae3e9', 0.025);
    this.box([w, 0.025, d], [0, 0.074, 0], '#eaf0f2');
    for (let x = -w / 2; x <= w / 2 + 0.001; x += 0.3) this.line([x, 0.088, -d / 2], [x, 0.088, d / 2], '#d2dde2', 0.7);
    for (let z = -d / 2; z <= d / 2 + 0.001; z += 0.3) this.line([-w / 2, 0.088, z], [w / 2, 0.088, z], '#d2dde2', 0.7);
    this.box([w + 0.14, h, 0.1], [0, h / 2, -d / 2 - 0.045], '#edf3f6');
    this.box([0.1, h, d + 0.12], [-w / 2 - 0.045, h / 2, 0], '#edf3f6');
    // Tile joints on the two visible walls.
    for (let y = 0.3; y < h; y += 0.3) {
      this.line([-w / 2, y, -d / 2 + 0.008], [w / 2, y, -d / 2 + 0.008], '#d9e2e7', 0.65);
      this.line([-w / 2 + 0.008, y, -d / 2], [-w / 2 + 0.008, y, d / 2], '#d9e2e7', 0.65);
    }
    for (let x = -w / 2 + 0.3; x < w / 2; x += 0.3) this.line([x, 0, -d / 2 + 0.008], [x, h, -d / 2 + 0.008], '#d9e2e7', 0.65);
    for (let z = -d / 2 + 0.3; z < d / 2; z += 0.3) this.line([-w / 2 + 0.008, 0, z], [-w / 2 + 0.008, h, z], '#d9e2e7', 0.65);
    // Cutaway walls are visually translucent only; solver boundaries stay solid.
    const ghost = this.box([0.025, h, d], [w / 2, h / 2, 0], '#c9dfed', 0, this.architecture, { transparent: true, opacity: 0.08, depthWrite: false });
    ghost.castShadow = false; this.ghosts.push(ghost);
    for (const x of [-w / 2, w / 2]) this.ghosts.push(this.line([x, h, -d / 2], [x, h, d / 2], '#a8bbc9', 0.65));
    this.ghosts.push(this.line([-w / 2, h, d / 2], [w / 2, h, d / 2], '#a8bbc9', 0.5));
    this.ghosts.push(this.line([w / 2, 0, d / 2], [w / 2, h, d / 2], '#a8bbc9', 0.65));
    const doorLeft = DOOR_CENTER - DOOR_WIDTH / 2, doorRight = DOOR_CENTER + DOOR_WIDTH / 2;
    for (const [a, b] of [[-w / 2, doorLeft], [doorRight, w / 2]]) {
      if (b > a) {
        const m = this.box([b - a, h, 0.035], [(a + b) / 2, h / 2, d / 2], '#d6e6ee', 0, this.architecture, { transparent: true, opacity: 0.10, depthWrite: false });
        m.castShadow = false; this.ghosts.push(m);
      }
    }
    // Door frame and sliding door. Opening increases left to right.
    for (const x of [doorLeft, doorRight]) this.box([0.035, 1.98, 0.08], [x, 1.03, d / 2], '#c2cfd7');
    this.box([DOOR_WIDTH + 0.07, 0.045, 0.09], [DOOR_CENTER, 2.01, d / 2], '#c2cfd7');
    this.box([DOOR_WIDTH + 0.09, 0.02, 0.12], [DOOR_CENTER, 0.105, d / 2], '#c6d0d8');
    const doorPanel = new THREE.Group();
    doorPanel.position.set(DOOR_CENTER + DOOR_WIDTH * this.settings.door / 100, 0, d / 2 + 0.075);
    this.architecture.add(doorPanel);
    this.box([DOOR_WIDTH - 0.04, 1.86, 0.028], [0, 1.065, 0], '#dde9ec', 0, doorPanel, { transparent: true, opacity: 0.24, depthWrite: false }).castShadow = false;
    for (const x of [-DOOR_WIDTH / 2 + 0.02, DOOR_WIDTH / 2 - 0.02]) this.box([0.025, 1.9, 0.045], [x, 1.065, 0], '#b2c1cb', 0, doorPanel);
    for (const y of [0.115, 2.015]) this.box([DOOR_WIDTH - 0.02, 0.025, 0.045], [0, y, 0], '#b2c1cb', 0, doorPanel);
    this.rod([-0.31, 0.9, 0.045], [-0.31, 1.15, 0.045], 0.016, '#8295a4', doorPanel);
    // Ceramic bathtub with a recessed basin.
    const bx = -w / 2 + 0.41, bz = -0.69;
    this.box([0.79, 0.4, 1.27], [bx, 0.29, bz], '#fcfdfe', 0.08);
    this.box([0.58, 0.025, 1.02], [bx, 0.495, bz], '#cbdce4', 0.06);
    this.box([0.47, 0.015, 0.88], [bx, 0.51, bz], '#dce8ee', 0.07);
    for (const x of [bx - 0.35, bx + 0.35]) this.box([0.09, 0.08, 1.27], [x, 0.55, bz], '#ffffff', 0.035);
    for (const z of [bz - 0.59, bz + 0.59]) this.box([0.72, 0.08, 0.095], [bx, 0.55, z], '#ffffff', 0.035);
    // Shower rail, mixer, hose and head.
    this.rod([-w / 2 + 0.09, 0.87, -0.72], [-w / 2 + 0.09, 1.8, -0.72], 0.013, '#a0b4c0');
    this.rod([-w / 2 + 0.09, 1.76, -0.72], [-w / 2 + 0.25, 1.84, -0.72], 0.018, '#9dabb5');
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.075, 0.025, 24), this.material('#b5c4ce', { metalness: 0.8 }));
    head.position.set(-w / 2 + 0.25, 1.84, -0.72); head.rotation.z = -0.3; this.architecture.add(head);
    this.rod([-w / 2 + 0.12, 0.83, -0.89], [-w / 2 + 0.12, 0.83, -0.56], 0.027, '#99adb9');
    const hose = new THREE.CatmullRomCurve3([new THREE.Vector3(-w / 2 + 0.15, 0.83, -0.7), new THREE.Vector3(-w / 2 + 0.16, 0.65, -0.52), new THREE.Vector3(-w / 2 + 0.12, 1.33, -0.64), new THREE.Vector3(-w / 2 + 0.18, 1.79, -0.72)]);
    this.architecture.add(new THREE.Mesh(new THREE.TubeGeometry(hose, 24, 0.009, 6, false), this.material('#9cafba', { metalness: 0.7 })));
    this.box([0.44, 0.68, 0.026], [w / 2 - 0.36, 1.22, -1.283], '#a8bdcc', 0.02, this.architecture, { metalness: 0.6, roughness: 0.22 });
    this.box([0.48, 0.035, 0.18], [w / 2 - 0.36, 0.8, -1.21], '#ffffff', 0.018);
    for (const [offset, color] of [[-0.12, '#b7ced0'], [0.015, '#c7d5e3']] as const) {
      this.box([0.07, 0.15, 0.065], [w / 2 - 0.36 + offset, 0.89, -1.22], color, 0.012);
      this.box([0.04, 0.028, 0.04], [w / 2 - 0.36 + offset, 0.98, -1.22], '#71828e', 0.006);
    }
    this.box([0.16, 0.008, 0.16], [w / 2 - 0.4, 0.092, 0.59], '#bac9d2', 0.015);
    for (let i = 0; i < 4; i++) this.line([w / 2 - 0.46 + i * 0.04, 0.098, 0.53], [w / 2 - 0.46 + i * 0.04, 0.098, 0.65], '#8199a7');
    // The frame surrounds the same open faces used by the solver. Keep the
    // opening clear below the ceiling so trajectories can visibly reach it.
    const opening = exhaustOpening(this.settings.size), ventX = (opening.xMin + opening.xMax) / 2;
    const ventZ = (opening.zMin + opening.zMax) / 2, ventW = opening.xMax - opening.xMin, ventD = opening.zMax - opening.zMin;
    for (const x of [opening.xMin - 0.025, opening.xMax + 0.025]) this.box([0.05, 0.05, ventD + 0.1], [x, h + 0.025, ventZ], '#f9fcff', 0.01);
    for (const z of [opening.zMin - 0.025, opening.zMax + 0.025]) this.box([ventW, 0.05, 0.05], [ventX, h + 0.025, z], '#f9fcff', 0.01);
    for (let i = 0; i < 7; i++) this.box([ventW, 0.006, 0.01], [ventX, h + 0.035, opening.zMin + (i + 0.5) * ventD / 7], '#819eaf');
    for (const z of [opening.zMin, opening.zMax]) this.line([opening.xMin, h, z], [opening.xMax, h, z], '#298dad');
    for (const x of [opening.xMin, opening.xMax]) this.line([x, h, opening.zMin], [x, h, opening.zMax], '#298dad');
    // Laundry rail and hangers.
    this.rod([-w / 2 + 0.03, 1.91, 0], [w / 2 - 0.03, 1.91, 0], 0.018, '#99afbd');
    for (const x of [-w / 2 + 0.03, w / 2 - 0.03]) this.box([0.04, 0.09, 0.09], [x, 1.91, 0], '#c1d0d9', 0.015);
    clothingPositions(this.settings).forEach((x, index) => {
      this.rod([x, 1.88, 0], [x, 1.76, 0], 0.008, '#9aaeb9');
      this.rod([x, 1.76, 0], [x, 1.62, -0.27], 0.009, '#b0bdc6');
      this.rod([x, 1.76, 0], [x, 1.62, 0.27], 0.009, '#b0bdc6');
      this.rod([x, 1.62, -0.27], [x, 1.62, 0.27], 0.009, '#b0bdc6');
      const shape = new THREE.Shape();
      const outline = [[-0.085, 0], [-0.18, -0.035], [-0.33, -0.14], [-0.26, -0.31], [-0.18, -0.27], [-0.19, -0.75], [0.19, -0.75], [0.18, -0.27], [0.26, -0.31], [0.33, -0.14], [0.18, -0.035], [0.085, 0], [0.065, -0.07], [-0.065, -0.07]];
      outline.forEach(([a, b], i) => i ? shape.lineTo(a, b) : shape.moveTo(a, b)); shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.015, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: 0.012, bevelThickness: 0.008 });
      const shirt = new THREE.Mesh(geo, this.material(['#89b3d1', '#f7f5ef', '#bdccdb', '#739db9', '#e9e5dc', '#a6c4ce'][index % 6], { side: THREE.DoubleSide, roughness: 1 }));
      shirt.rotation.y = Math.PI / 2; shirt.position.set(x, 1.7, 0); shirt.castShadow = true; shirt.receiveShadow = true; this.architecture.add(shirt);
      // Subtle seams make the laundry read as fabric at a glance.
      this.line([x + 0.025, 1.05, -0.175], [x + 0.025, 1.05, 0.175], '#6e8fa5', 0.25);
    });
    // Circulator outside the bathroom; always visible, switched on/off.
    const fx = DOOR_CENTER, fz = 2.6;
    this.box([0.43, 0.085, 0.37], [fx, 0.005, fz], '#f9fcff', 0.05);
    this.rod([fx, 0.025, fz], [fx, 0.52, fz], 0.055, '#c1ccd5');
    const headStart = this.architecture.children.length;
    const cage = new THREE.Mesh(new THREE.CylinderGeometry(0.255, 0.23, 0.18, 40), this.material('#edf2f5'));
    cage.rotation.x = Math.PI / 2; cage.position.set(fx, 0.54, fz); this.architecture.add(cage);
    this.rotor = new THREE.Group(); this.rotor.position.set(fx, 0.54, fz - 0.105); this.architecture.add(this.rotor);
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), this.material('#92a8b7'));
      blade.scale.set(0.065, 0.135, 0.012); blade.position.set(Math.sin(i * Math.PI * 2 / 3) * 0.09, Math.cos(i * Math.PI * 2 / 3) * 0.09, 0); blade.rotation.z = -i * Math.PI * 2 / 3 - 0.4; this.rotor.add(blade);
    }
    for (let r = 0.07; r <= 0.24; r += 0.038) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.004, 5, 48), this.material('#b6c5d0'));
      ring.position.set(fx, 0.54, fz - 0.124); this.architecture.add(ring);
    }
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      this.rod([fx, 0.54, fz - 0.13], [fx + Math.sin(a) * 0.24, 0.54 + Math.cos(a) * 0.24, fz - 0.13], 0.0035, '#b6c5d0');
    }
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 8), this.material('#f2f6f9')); hub.scale.z = 0.4; hub.position.set(fx, 0.54, fz - 0.14); this.architecture.add(hub);
    const fanHead = new THREE.Group(), pivot = new THREE.Vector3(fx, 0.54, fz);
    for (const child of this.architecture.children.slice(headStart)) { child.position.sub(pivot); fanHead.add(child); }
    fanHead.position.copy(pivot);
    const direction = new THREE.Vector3(...fanDirection(this.settings));
    fanHead.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), direction);
    this.architecture.add(fanHead);
    if (this.settings.fan) this.architecture.add(new THREE.ArrowHelper(direction, pivot.clone().addScaledVector(direction, 0.3), 0.55, '#6c9fce', 0.11, 0.065));
    // Low room outline and a bath mat establish the exterior space.
    this.box([0.82, 0.018, 0.47], [DOOR_CENTER, -0.032, 1.78], '#bdcdd1', 0.035);
    for (let x = -0.15; x < 0.6; x += 0.055) this.line([x, -0.021, 1.6], [x, -0.021, 1.96], '#aebfc4', 0.5);
    this.line([-platformW / 2 + 0.1, -0.045, 3.35], [platformW / 2 + 0.1, -0.045, 3.35], '#b4c1c8');
    for (const obj of this.ghosts) obj.visible = this.options.walls;
    this.renderer.shadowMap.needsUpdate = true;
  }
  setSettings(settings: Settings) {
    const reset = !sameGeometry(this.settings, settings);
    this.settings = settings; if (reset) this.clearFlow(); this.buildRoom();
  }
  clearFlow() {
    this.field = null; this.lines.visible = this.points.visible = this.streamlines.visible = this.vectors.visible = this.vectorGuides.visible = this.vectorPoints.visible = false;
    this.streamlinesDirty = true; this.nextStreamlineUpdate = 0;
    this.vectorsDirty = true; this.nextVectorUpdate = 0; this.seedCells = [];
    this.vectorMotion.clear();
    this.elapsed = 0; this.historyTime = 0; this.incomingRate = 1; this.onTick?.(0);
  }
  setField(field: FlowField) {
    const first = !this.field;
    // Use solver cost, not the interval between deliveries: that interval also
    // includes intentional buffering/pauses and would cause feedback slowdown.
    if (this.field && field.computationMs) this.incomingRate = Math.min(this.options.speed, Math.max(0.05, (field.time - this.field.time) / (field.computationMs / 1000)));
    this.field = field; this.streamlinesDirty = this.vectorsDirty = true;
    if (first) {
      this.seedCells = particleSeedCells(field, this.settings);
      for (let i = 0; i < this.count; i++) this.spawn(i, true);
      this.updateParticles(0);
    }
  }
  setOptions(options: SceneOptions) {
    if (this.options.playing && !options.playing) this.onTick?.(this.elapsed);
    const recolor = this.options.colorMode !== options.colorMode;
    if (recolor || this.options.mode !== options.mode) {
      this.streamlinesDirty = this.vectorsDirty = true;
      this.nextStreamlineUpdate = this.nextVectorUpdate = 0;
    }
    this.options = options;
    if (recolor && this.field) this.updateParticles(0);
    for (const obj of this.ghosts) obj.visible = options.walls;
  }
  setView(view: View) {
    this.controls.target.set(0, 0.75, 0.65);
    this.camera.position.copy(this.controls.target).add(new THREE.Vector3(...(view === 'top' ? [0, 10, 0.001] : view === 'front' ? [0.001, 2.5, 10] : [6.7, 8.5, 8.8]) as [number, number, number]));
    this.camera.zoom = 1; this.camera.updateProjectionMatrix(); this.controls.update();
  }
  zoom(factor: number) { this.camera.zoom = THREE.MathUtils.clamp(this.camera.zoom * factor, 0.55, 3); this.camera.updateProjectionMatrix(); }
  reset() { if (this.field) { for (let i = 0; i < this.count; i++) this.spawn(i, true); this.updateParticles(0); } }
  private resizeCanvas() {
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    this.renderer.setSize(width, height); const half = width < 650 ? 3.4 : 3.0;
    this.camera.left = -half * width / height; this.camera.right = half * width / height; this.camera.top = half; this.camera.bottom = -half; this.camera.updateProjectionMatrix();
  }
  private spawn(i: number, stratified = false) {
    if (!this.field || !this.seedCells.length) return;
    // Initially cover the equal-volume cells evenly; recycling samples the
    // same whole domain. No dedicated inlet/outlet population is added.
    const fraction = stratified ? (i + Math.random()) / this.count : Math.random();
    const [x, y, z] = particleSeed(this.field, this.seedCells, fraction);
    this.particles.set([x, y, z], i * 3); this.ages[i] = Math.random() * 12;
    this.exitAges[i] = -1;
    for (let t = 0; t < this.trailLength; t++) this.history.set([x, y, z], (i * this.trailLength + t) * 3);
  }
  private updateParticles(dt: number) {
    if (!this.field) return;
    const f = this.field;
    this.historyTime += dt;
    const recordHistory = this.historyTime >= 0.07;
    if (recordHistory) this.historyTime %= 0.07;
    for (let i = 0; i < this.count; i++) {
      const p = i * 3;
      let x = this.particles[p], y = this.particles[p + 1], z = this.particles[p + 2];
      if (this.exitAges[i] >= 0) {
        // Retain the final segment at the mouth briefly, then recycle it.
        this.exitAges[i] += dt;
        if (this.exitAges[i] >= 0.6) this.spawn(i);
        x = this.particles[p]; y = this.particles[p + 1]; z = this.particles[p + 2];
      } else {
        const moved = advanceParticle(f, [x, y, z], dt);
        [x, y, z] = moved.position; this.ages[i] += dt;
        if (moved.exited) this.exitAges[i] = 0;
        if (!moved.exited && (moved.blocked || this.ages[i] > 300)) {
          this.spawn(i); x = this.particles[p]; y = this.particles[p + 1]; z = this.particles[p + 2];
        } else this.particles.set([x, y, z], p);
      }
      const speed = Math.hypot(...sampleVelocity(f, x, y, z, this.vec));
      const start = i * this.trailLength * 3;
      if (recordHistory && this.exitAges[i] <= 0) this.history.copyWithin(start, start + 3, start + this.trailLength * 3);
      this.history.set([x, y, z], start + (this.trailLength - 1) * 3);
      if (this.options.colorMode === 'speed') flowColor(speed, this.color);
      else { const strength = Math.min(1, sampleVorticity(f, x, y, z) / 3); this.color.setHSL(0.61 + strength * 0.35, 0.73, 0.57); }
      this.pointColors.set([this.color.r, this.color.g, this.color.b], p);
      for (let t = 0; t < this.trailLength - 1; t++) {
        const a = start + t * 3, target = (i * (this.trailLength - 1) + t) * 6;
        for (let c = 0; c < 6; c++) this.linePositions[target + c] = this.history[a + c];
        const fade = 0.25 + 0.75 * t / (this.trailLength - 1);
        const r = this.color.r * fade, g = this.color.g * fade, b = this.color.b * fade;
        this.lineColors[target] = this.lineColors[target + 3] = r;
        this.lineColors[target + 1] = this.lineColors[target + 4] = g;
        this.lineColors[target + 2] = this.lineColors[target + 5] = b;
      }
    }
    this.lines.geometry.attributes.position.needsUpdate = true; this.lines.geometry.attributes.color.needsUpdate = true;
    this.points.geometry.attributes.position.needsUpdate = true; this.points.geometry.attributes.color.needsUpdate = true;
  }
  private updateVectors() {
    if (!this.field) return;
    const positions: number[] = [], colors: number[] = [], origins: number[] = [];
    const samples = flowVectors(this.field, uniformFlowSeeds(this.settings, VECTOR_SPACING));
    this.vectorMotion.setSamples(samples);
    for (const sample of samples) {
      origins.push(...sample.position);
      positions.push(...sample.position, ...sample.end);
      if (this.options.colorMode === 'speed') flowColor(sample.speed, this.color);
      else this.color.setHSL(0.61 + Math.min(1, sample.vorticity / 3) * 0.35, 0.73, 0.57);
      colors.push(this.color.r, this.color.g, this.color.b, this.color.r, this.color.g, this.color.b);
    }
    const guides = new THREE.BufferGeometry();
    guides.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    guides.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.vectorGuides.geometry.dispose(); this.vectorGuides.geometry = guides;
    const points = new THREE.BufferGeometry();
    points.setAttribute('position', new THREE.Float32BufferAttribute(origins, 3));
    this.vectorPoints.geometry.dispose(); this.vectorPoints.geometry = points;
    // Reuse GPU buffers between animation frames. Ten vertices allow a shaft
    // and four head wings per sample; clipped wings use a smaller draw range.
    const capacity = samples.length * 10;
    if (this.vectors.geometry.attributes.position?.count !== capacity) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
      this.vectors.geometry.dispose(); this.vectors.geometry = geometry;
    }
    this.vectorsDirty = false;
  }
  private animateVectors(simulatedDt: number) {
    if (!this.field) return;
    this.vectorMotion.advance(simulatedDt);
    const positions = this.vectors.geometry.attributes.position;
    const colors = this.vectors.geometry.attributes.color;
    if (!positions || !colors) return;
    let vertex = 0, opacity = 1;
    const start = new THREE.Vector3(), end = new THREE.Vector3(), direction = new THREE.Vector3();
    const side = new THREE.Vector3(), normal = new THREE.Vector3(), wing = new THREE.Vector3();
    const segment = (a: THREE.Vector3, b: THREE.Vector3) => {
      positions.setXYZ(vertex, a.x, a.y, a.z); positions.setXYZ(vertex + 1, b.x, b.y, b.z);
      for (let i = 0; i < 2; i++) colors.setXYZW(vertex++, this.color.r, this.color.g, this.color.b, opacity);
    };
    for (let i = 0; i < this.vectorMotion.tracks.length; i++) {
      const arrow = this.vectorMotion.arrow(i);
      if (!arrow) continue; // A stationary point stays visible as a dot.
      const sample = this.vectorMotion.tracks[i].sample;
      start.fromArray(arrow.start); end.fromArray(arrow.end); opacity = arrow.opacity;
      const length = start.distanceTo(end);
      if (length < 1e-5) continue;
      if (this.options.colorMode === 'speed') flowColor(sample.speed, this.color);
      else this.color.setHSL(0.61 + Math.min(1, sample.vorticity / 3) * 0.35, 0.73, 0.57);
      segment(start, end);
      direction.subVectors(end, start).normalize();
      side.set(Math.abs(direction.y) > 0.9 ? 1 : 0, Math.abs(direction.y) > 0.9 ? 0 : 1, 0).cross(direction).normalize();
      normal.crossVectors(direction, side).normalize();
      const head = Math.min(0.035, length * 0.6);
      for (const axis of [side, normal]) for (const sign of [-1, 1]) {
        wing.copy(end).addScaledVector(direction, -head).addScaledVector(axis, head * 0.45 * sign);
        if (isFluidSegment(this.field, arrow.end, wing.toArray())) segment(wing, end);
      }
    }
    this.vectors.geometry.setDrawRange(0, vertex);
    positions.needsUpdate = colors.needsUpdate = true;
  }
  private updateStreamlines() {
    if (!this.field) return;
    const positions: number[] = [], colors: number[] = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), direction = new THREE.Vector3(), side = new THREE.Vector3();
    const segment = (start: THREE.Vector3, end: THREE.Vector3) => {
      positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
      colors.push(this.color.r, this.color.g, this.color.b, this.color.r, this.color.g, this.color.b);
    };
    for (const seed of streamlineSeeds(this.settings)) {
      const path = traceStreamline(this.field, seed);
      let sinceArrow = 0;
      for (let i = 1; i < path.length; i++) {
        const p = path[i]; a.fromArray(path[i - 1].position); b.fromArray(p.position);
        if (this.options.colorMode === 'speed') flowColor(p.speed, this.color);
        else this.color.setHSL(0.61 + Math.min(1, p.vorticity / 3) * 0.35, 0.73, 0.57);
        segment(a, b); sinceArrow += a.distanceTo(b);
        if (sinceArrow >= 0.5) {
          direction.subVectors(b, a).normalize();
          side.set(-direction.z, 0, direction.x);
          if (side.lengthSq() < 0.01) side.set(0, direction.z, -direction.y);
          side.normalize().multiplyScalar(0.022);
          a.copy(b).addScaledVector(direction, -0.055).add(side); segment(a, b);
          a.addScaledVector(side, -2); segment(a, b);
          sinceArrow = 0;
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.streamlines.geometry.dispose(); this.streamlines.geometry = geometry;
    this.streamlinesDirty = false;
  }
  private updateLabels() {
    const w = roomWidth(this.settings.size), opening = exhaustOpening(this.settings.size);
    const anchors: Record<string, number[]> = { exhaust: [(opening.xMin + opening.xMax) / 2, HEIGHT + 0.25, (opening.zMin + opening.zMax) / 2], laundry: [-w / 2 - 0.12, 1.85, 0.02], fan: [0.2, 0.35, 2.84], size: [w / 2 + 0.28, 0, 0.05] };
    for (const [key, node] of this.labelNodes) {
      const p = new THREE.Vector3(...anchors[key] as [number, number, number]).project(this.camera);
      const screenY = (-p.y * 0.5 + 0.5) * this.host.clientHeight;
      node.style.left = `${(p.x * 0.5 + 0.5) * this.host.clientWidth}px`; node.style.top = `${screenY}px`;
      node.style.visibility = Math.abs(p.x) > 0.95 || Math.abs(p.y) > 0.93 || (key === 'fan' && screenY > this.host.clientHeight - 105) ? 'hidden' : 'visible';
    }
  }
  private animate = (time: number) => {
    if (this.disposed) return;
    const dt = Math.min((time - this.lastTime) / 1000, 0.25); this.lastTime = time;
    this.controls.update();
    let simulatedDt = 0;
    if (this.options.playing && this.field) {
      simulatedDt = Math.min(Math.max(0, this.field.time - this.elapsed), dt * this.incomingRate);
      if (simulatedDt > 0) { this.updateParticles(simulatedDt); this.elapsed += simulatedDt; }
      if (this.field.time - this.elapsed < 0.24) this.onAdvance?.(dt);
      if (this.settings.fan) this.rotor.rotation.z -= dt * 18;
    }
    this.lines.visible = !!this.field && this.options.flow && this.options.mode === 'trails';
    this.points.visible = !!this.field && this.options.flow && (this.options.mode === 'trails' || this.options.mode === 'particles');
    this.streamlines.visible = !!this.field && this.options.flow && this.options.mode === 'streamlines';
    this.vectors.visible = this.vectorGuides.visible = this.vectorPoints.visible = !!this.field && this.options.flow && this.options.mode === 'vectors';
    if (this.vectors.visible) {
      const refresh = this.vectorsDirty && time >= this.nextVectorUpdate;
      if (refresh) { this.updateVectors(); this.nextVectorUpdate = time + 250; }
      if (refresh || simulatedDt > 0) this.animateVectors(simulatedDt);
    }
    if (this.streamlines.visible && this.streamlinesDirty && time >= this.nextStreamlineUpdate) {
      this.updateStreamlines(); this.nextStreamlineUpdate = time + 1000;
    }
    this.updateLabels(); this.renderer.render(this.scene, this.camera);
    if (time > this.nextTick) { this.onTick?.(this.elapsed); this.nextTick = time + 500; }
    this.frame = requestAnimationFrame(this.animate);
  };
  screenshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/png'); }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.frame); this.resize.disconnect(); this.controls.dispose();
    disposeGroup(this.scene); this.renderer.dispose(); this.renderer.forceContextLoss(); this.renderer.domElement.remove();
  }
}
