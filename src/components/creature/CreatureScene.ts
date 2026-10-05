// LUSCA creature — a point-cloud octopus seen from above, eight arms splayed over
// an instrument dial. Agents live on the arms as suckers; the crypto web lives
// around it as square data points grouped by host inside each arm's sector.
//
//   fetch  → a filament shoots from the agent's sucker to the page node
//   taste  → the filament burns hot while the agent scores the page
//   store  → a packet rides the filament back, up the arm, into the mantle,
//            and the mantle's chromatophores flash toward that arm
//   reject → the filament snaps back and the node burns out red
//
// Pure three.js (no React) so it can run at 60fps independent of renders.

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { AgentInfo, AgentState, DomainInfo, PageRecord, ServerMsg } from '@shared/protocol'
import { SECTORS, sectorForHost } from '@shared/sectors'
import { fnv1a } from '@shared/vectorize'
import { POINT_SIZE, SNOISE } from './glsl'

const TAU = Math.PI * 2
const ARMS = 8
const SEG = 72
const HUB_R = 0.66
const R0 = 0.33
const WEB_IN = 6.7
const WEB_OUT = 11.6
const DIAL_R = 12.7
const MAX_AGENTS = 64
const FIL_SEG = 22
const MAX_PACKETS = 256

export type CreatureVariant = 'hero' | 'observatory' | 'mini'

export interface CreatureOptions {
  variant: CreatureVariant
  interactive: boolean
  labels: boolean
  onSelect?: (id: number | null) => void
  onHover?: (id: number | null) => void
}

const STATE_CODE: Record<AgentState, number> = {
  idle: 0, seek: 1, fetch: 2, parse: 3, taste: 3, dedupe: 3, store: 4, reject: 5, error: 5, sleep: 6,
}

function h01(s: string): number {
  return fnv1a(s) / 4294967296
}

export function armAngle(i: number): number {
  return (i / ARMS) * TAU + TAU / 16 - Math.PI / 2
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI
  return a + d * t
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.split('/')[2] ?? url
  }
}

function linear(hex: string): THREE.Color {
  return new THREE.Color(hex) // ColorManagement converts sRGB hex → linear working space
}

const C = {
  bone: linear('#ecebe6'),
  hot: linear('#ff4d00'),
  err: linear('#ff2e3a'),
  dim: linear('#5a5953'),
  line: linear('#262626'),
  line2: linear('#3a3a3a'),
}

interface Domain {
  host: string
  sector: number
  center: THREE.Vector3
  count: number
  frontier: number
  discovered: boolean
  bornAt: number
}

interface AgentVis {
  info: AgentInfo
  state: AgentState
  stateAt: number
  fil: number          // 0 off, 1 fetch, 2 work, 3 store, 4 reject
  ext: number
  extTarget: number
  alpha: number
  nodeIdx: number
  pos: THREE.Vector3   // sucker world position (updated per frame)
  screen: THREE.Vector2
  onScreen: boolean
}

interface Packet {
  agent: number
  arm: number
  j: number            // sucker spine index
  phase: 0 | 1 | 2
  t: number
  alive: boolean
  from: THREE.Vector3
}

const VARIANTS: Record<CreatureVariant, { fov: number; pos: [number, number, number]; target: [number, number, number]; spin: number; bloom: number; webCap: number; edgeCap: number; ring: number }> = {
  hero: { fov: 28, pos: [0, 15.5, 17.5], target: [0, -0.6, 0.6], spin: 0.035, bloom: 0.75, webCap: 5000, edgeCap: 3500, ring: 12 },
  observatory: { fov: 34, pos: [0, 18.5, 13.5], target: [0, 0, 0.6], spin: 0.03, bloom: 0.65, webCap: 9000, edgeCap: 7000, ring: 12 },
  mini: { fov: 30, pos: [0, 30, 6], target: [0, 0, 0], spin: 0.05, bloom: 0.55, webCap: 3000, edgeCap: 1500, ring: 8 },
}

export class CreatureScene {
  readonly el: HTMLElement
  private opts: CreatureOptions
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private controls: OrbitControls | null = null
  private clock = new THREE.Clock()
  private raf = 0
  private running = false
  private visible = true
  private disposed = false
  private time = 0
  private pointer = new THREE.Vector2(0, 0)
  private pointerSmooth = new THREE.Vector2(0, 0)
  private width = 1
  private height = 1
  private lowPower: boolean

  // shared uniforms
  private uTime = { value: 0 }
  private uScale = { value: 600 }
  private uPixelRatio = { value: 1 }
  private uArmAct = { value: new Float32Array(ARMS) }
  private uHeat = { value: new Float32Array(ARMS) }

  // arms
  private ring: number
  private spine: Float32Array[] = []
  private frameB: Float32Array[] = []
  private frameN: Float32Array[] = []
  private radius = new Float32Array(SEG)
  private armReach = new Float32Array(ARMS)
  private armReachAngle = new Float32Array(ARMS)
  private bodyGeo!: THREE.BufferGeometry
  private bodyPos!: Float32Array
  private bodyNrm!: Float32Array
  private outlineGeo!: THREE.BufferGeometry
  private outlinePos!: Float32Array
  private suckerGeo!: THREE.BufferGeometry
  private suckerPos!: Float32Array
  private suckerIdx: { arm: number; j: number; side: number }[] = []
  private membraneGeo!: THREE.BufferGeometry
  private membranePos!: Float32Array
  private membraneIdx: { i: number; j: number; u: number }[] = []

  // mantle
  private mantle!: THREE.Points
  private eyes: THREE.Sprite[] = []
  private blinkAt = 3

  // web
  private webCap: number
  private webGeo!: THREE.BufferGeometry
  private webPos!: Float32Array
  private webSize!: Float32Array
  private webBirth!: Float32Array
  private webKind!: Float32Array
  private webSeed!: Float32Array
  private webNext = 0
  private webUrl: (string | null)[] = []
  private urlIndex = new Map<string, number>()
  private domains = new Map<string, Domain>()
  private knownDomains = new Map<string, DomainInfo>()
  private webDirty = false

  private edgeCap: number
  private edgeGeo!: THREE.BufferGeometry
  private edgePos!: Float32Array
  private edgeBirth!: Float32Array
  private edgeNext = 0
  private edgeDirty = false

  // agents
  private agents = new Map<number, AgentVis>()
  private markerGeo!: THREE.BufferGeometry
  private markerPos!: Float32Array
  private markerState!: Float32Array
  private markerSel!: Float32Array
  private markerAge!: Float32Array
  private filGeo!: THREE.BufferGeometry
  private filPos!: Float32Array
  private uFilExt = { value: new Float32Array(MAX_AGENTS) }
  private uFilKind = { value: new Float32Array(MAX_AGENTS) }
  private uFilAlpha = { value: new Float32Array(MAX_AGENTS) }
  private selected: number | null = null
  private hovered: number | null = null

  // packets
  private packets: Packet[] = []
  private packetGeo!: THREE.BufferGeometry
  private packetPos!: Float32Array
  private packetAlpha!: Float32Array

  // atmosphere
  private rings: { line: THREE.LineLoop; born: number; life: number; r0: number; r1: number; base: number; at: THREE.Vector3 }[] = []
  private nextSweep = 1.5

  // overlay labels
  private labelLayer: HTMLElement | null = null
  private sectorLabels: HTMLElement[] = []
  private domainLabels: HTMLElement[] = []
  private agentLabel: HTMLElement | null = null
  private flashLabels: { el: HTMLElement; pos: THREE.Vector3; until: number }[] = []
  private labelTick = 0
  /** Pages kept per arm, from the server; null = no server data (label shows "—"). */
  private sectorCounts: (number | null)[] = new Array(ARMS).fill(null)

  private tmpV = new THREE.Vector3()
  private tmpV2 = new THREE.Vector3()
  private ro: ResizeObserver
  private io: IntersectionObserver

  constructor(el: HTMLElement, opts: CreatureOptions) {
    this.el = el
    this.opts = opts
    const v = VARIANTS[opts.variant]
    const nav = navigator as Navigator & { deviceMemory?: number }
    this.lowPower = (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) || window.innerWidth < 720
    this.ring = this.lowPower ? Math.min(8, v.ring) : v.ring
    this.webCap = this.lowPower ? Math.floor(v.webCap * 0.5) : v.webCap
    this.edgeCap = this.lowPower ? Math.floor(v.edgeCap * 0.5) : v.edgeCap

    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' })
    // The composer clears its float render target with the sRGB-encoded clear value and
    // OutputPass encodes again, so pre-compensate: this lands exactly on #050505.
    const toLin = (c: number) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4))
    const k = toLin(toLin(5 / 255))
    this.renderer.setClearColor(new THREE.Color().setRGB(k, k, k, THREE.LinearSRGBColorSpace), 1)
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    el.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(v.fov, 1, 0.1, 200)
    this.camera.position.set(...v.pos)
    this.camera.lookAt(new THREE.Vector3(...v.target))

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), v.bloom, 0.42, 0.32)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())

    if (opts.interactive) {
      const c = new OrbitControls(this.camera, this.renderer.domElement)
      c.target.set(...v.target)
      c.enableDamping = true
      c.dampingFactor = 0.06
      c.minDistance = 9
      c.maxDistance = 40
      c.maxPolarAngle = 1.32
      c.enablePan = false
      c.rotateSpeed = 0.6
      c.zoomSpeed = 0.8
      c.autoRotate = true
      c.autoRotateSpeed = 0.18
      this.controls = c
    }

    for (let i = 0; i < ARMS; i++) {
      this.spine.push(new Float32Array(SEG * 3))
      this.frameB.push(new Float32Array(SEG * 3))
      this.frameN.push(new Float32Array(SEG * 3))
    }
    for (let j = 0; j < SEG; j++) {
      const s = j / (SEG - 1)
      this.radius[j] = R0 * Math.pow(1 - s, 1.25) * (1 + 0.35 * Math.exp(-s * 9)) + 0.014
    }

    this.buildDial()
    this.buildArms()
    this.buildMantle()
    this.buildWeb()
    this.buildAgents()
    this.buildPackets()
    this.buildAtmosphere()

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(el)
    this.io = new IntersectionObserver((entries) => {
      this.visible = entries.some((e) => e.isIntersecting)
      if (this.visible) this.start()
    })
    this.io.observe(el)
    this.resize()

    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerleave', this.onPointerLeave)
    if (opts.interactive) el.addEventListener('click', this.onClick)
    document.addEventListener('visibilitychange', this.onVisibility)
    if (import.meta.env.DEV) (window as unknown as { __creature: CreatureScene }).__creature = this
    this.start()
  }

  /** dev: tweak bloom live */
  tuneBloom(strength: number, radius: number, threshold: number) {
    this.bloom.strength = strength
    this.bloom.radius = radius
    this.bloom.threshold = threshold
  }

  // ─── public API ────────────────────────────────────────────────

  setLabelLayer(layer: HTMLElement | null) {
    this.labelLayer = layer
    if (!layer || !this.opts.labels) return
    layer.innerHTML = ''
    this.sectorLabels = SECTORS.map((s) => {
      const d = document.createElement('div')
      d.className = 'cl-sector'
      d.innerHTML = `<span class="cl-roman">${s.roman}</span><span class="cl-name">${s.name}</span><span class="cl-count num">—</span>`
      layer.appendChild(d)
      return d
    })
    this.domainLabels = Array.from({ length: this.opts.variant === 'observatory' ? 14 : 6 }, () => {
      const d = document.createElement('div')
      d.className = 'cl-domain'
      layer.appendChild(d)
      return d
    })
    const a = document.createElement('div')
    a.className = 'cl-agent'
    layer.appendChild(a)
    this.agentLabel = a
  }

  select(id: number | null) {
    this.selected = id
  }

  /** Per-arm page counts from a hello / stats message; null clears them to "—". */
  setSectorCounts(sectors: { id: number; pages: number }[] | null) {
    this.sectorCounts.fill(null)
    if (sectors) for (const s of sectors) if (s.id >= 0 && s.id < ARMS) this.sectorCounts[s.id] = s.pages
  }

  /** The server link is down: drop every agent, page and count so nothing stale is drawn. */
  clear() {
    this.reset([], [], [])
    this.setSectorCounts(null)
    if (this.labelLayer) for (const el of this.domainLabels) el.style.display = 'none'
  }

  /** Full reset from a hello snapshot (or store state). */
  reset(agents: AgentInfo[], pages: PageRecord[], domains: DomainInfo[]) {
    this.urlIndex.clear()
    this.webUrl = new Array(this.webCap).fill(null)
    this.webKind.fill(4)
    this.webSize.fill(0)
    this.webNext = 0
    this.edgeNext = 0
    this.edgeBirth.fill(-1000)
    this.edgePos.fill(0)
    this.domains.clear()
    this.knownDomains.clear()
    this.packets.length = 0
    for (const d of domains) this.knownDomains.set(d.host, d)
    // domains + ambient frontier so the web reads populated from the first frame
    const sorted = domains.slice().sort((a, b) => b.pages - a.pages)
    for (const d of sorted) {
      const dom = this.domainFor(d.host, d.sector)
      dom.count = d.pages
      dom.frontier = d.frontier
      const ambient = Math.min(26, Math.round(Math.sqrt(d.frontier) * 2.2))
      for (let k = 0; k < ambient; k++) this.addNode(`${d.host}#f${k}`, 0, d.sector, -100)
    }
    const old = pages.slice().reverse()
    for (const p of old) {
      const idx = this.addNode(p.url, 2, p.sector, -100)
      this.webSize[idx] = this.sizeForTokens(p.tokens)
    }
    // stitch a few edges between pages of the same host for texture
    const byHost = new Map<string, number[]>()
    for (const p of old) {
      const idx = this.urlIndex.get(p.url)
      if (idx === undefined) continue
      const list = byHost.get(p.host) ?? []
      list.push(idx)
      byHost.set(p.host, list)
    }
    for (const list of byHost.values()) for (let i = 1; i < list.length; i++) this.addEdge(list[i - 1], list[i], -100)
    this.setAgents(agents)
    this.webDirty = true
  }

  setAgents(list: AgentInfo[]) {
    const seen = new Set<number>()
    for (const a of list) {
      seen.add(a.id)
      const v = this.agents.get(a.id)
      if (v) {
        if (v.state !== a.state) this.onState(v, a)
        v.info = a
      } else {
        this.agents.set(a.id, {
          info: a, state: a.state, stateAt: this.time, fil: 0, ext: 0, extTarget: 0, alpha: 0,
          nodeIdx: -1, pos: new THREE.Vector3(), screen: new THREE.Vector2(), onScreen: false,
        })
      }
    }
    for (const id of [...this.agents.keys()]) if (!seen.has(id)) this.agents.delete(id)
  }

  handle(msg: ServerMsg) {
    switch (msg.t) {
      case 'hello':
        this.reset(msg.agents, msg.recent, msg.domains)
        this.setSectorCounts(msg.sectors)
        return
      case 'agent': {
        const a = msg.agent
        const v = this.agents.get(a.id)
        if (!v) {
          this.setAgents([...[...this.agents.values()].map((x) => x.info), a])
          return
        }
        if (v.state !== a.state) this.onState(v, a)
        v.info = a
        return
      }
      case 'page': {
        const p = msg.page
        let idx = this.urlIndex.get(p.url)
        if (idx === undefined) idx = this.addNode(p.url, 2, p.sector, this.time)
        else this.setKind(idx, 2)
        this.webSize[idx] = this.sizeForTokens(p.tokens)
        this.pulse(this.nodeWorld(idx, new THREE.Vector3()), 0.05, 0.75, 0.9, 0.7, C.hot)
        const dom = this.domains.get(p.host.replace(/^www\./, ''))
        if (dom) dom.count++
        const n = this.sectorCounts[p.sector]
        if (n != null) this.sectorCounts[p.sector] = n + 1
        this.webDirty = true
        return
      }
      case 'discover': {
        let from = this.urlIndex.get(msg.from)
        const ag = this.agents.get(msg.agentId)
        const sec = ag?.info.sector ?? 0
        if (from === undefined) from = this.addNode(msg.from, 2, sec, -100)
        for (const p of msg.picks) {
          if (this.urlIndex.has(p.url)) continue
          const idx = this.addNode(p.url, 0, sec, this.time)
          this.addEdge(from, idx, this.time)
        }
        return
      }
      case 'reject': {
        const idx = this.urlIndex.get(msg.url)
        if (idx !== undefined) this.setKind(idx, 3)
        return
      }
      case 'domain': {
        const d = msg.domain
        const isNew = !this.knownDomains.has(d.host)
        this.knownDomains.set(d.host, d)
        const dom = this.domainFor(d.host, d.sector)
        dom.count = d.pages
        dom.frontier = d.frontier
        if (isNew && d.discovered) {
          this.flash(`NEW HOST · ${d.host}`, dom.center, 4)
          this.pulse(dom.center, 0.1, 2.2, 1.6, 0.9, C.hot)
        }
        return
      }
      case 'stats':
        this.setSectorCounts(msg.sectors)
        return
      default:
        return
    }
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.io.disconnect()
    this.el.removeEventListener('pointermove', this.onPointerMove)
    this.el.removeEventListener('pointerleave', this.onPointerLeave)
    this.el.removeEventListener('click', this.onClick)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.controls?.dispose()
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      m.geometry?.dispose?.()
      const mat = m.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
      else mat?.dispose?.()
    })
    this.composer.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    if (this.labelLayer) this.labelLayer.innerHTML = ''
  }

  // ─── construction ──────────────────────────────────────────────

  private pointMaterial(vertex: string, fragment: string, extra: Record<string, THREE.IUniform> = {}, blending: THREE.Blending = THREE.AdditiveBlending) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uTime,
        uScale: this.uScale,
        uPixelRatio: this.uPixelRatio,
        uBone: { value: C.bone },
        uHot: { value: C.hot },
        uErr: { value: C.err },
        uDim: { value: C.dim },
        ...extra,
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      blending,
    })
  }

  private buildDial() {
    const pts: number[] = []
    const ring = (r: number, segs: number, y = 0) => {
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * TAU
        const a1 = ((i + 1) / segs) * TAU
        pts.push(Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r)
      }
    }
    const dashed = (r: number, segs: number) => {
      for (let i = 0; i < segs; i += 2) {
        const a0 = (i / segs) * TAU
        const a1 = ((i + 1) / segs) * TAU
        pts.push(Math.cos(a0) * r, 0, Math.sin(a0) * r, Math.cos(a1) * r, 0, Math.sin(a1) * r)
      }
    }
    ring(DIAL_R, 256)
    ring(DIAL_R + 0.55, 256)
    dashed(WEB_IN - 0.3, 180)
    dashed(3.2, 96)
    // ticks every 2°, long every 10°
    for (let d = 0; d < 360; d += 2) {
      const a = (d / 360) * TAU
      const len = d % 10 === 0 ? 0.42 : 0.18
      pts.push(Math.cos(a) * DIAL_R, 0, Math.sin(a) * DIAL_R, Math.cos(a) * (DIAL_R + len), 0, Math.sin(a) * (DIAL_R + len))
    }
    // sector boundaries (between arms)
    for (let i = 0; i < ARMS; i++) {
      const a = armAngle(i) - TAU / 16
      pts.push(Math.cos(a) * (WEB_IN - 0.3), 0, Math.sin(a) * (WEB_IN - 0.3), Math.cos(a) * (DIAL_R + 0.55), 0, Math.sin(a) * (DIAL_R + 0.55))
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const m = new THREE.LineBasicMaterial({ color: C.line2, transparent: true, opacity: 0.55, depthWrite: false })
    const lines = new THREE.LineSegments(g, m)
    lines.position.y = -0.6
    this.scene.add(lines)

    // orange sector index marks on the outer ring
    const mk: number[] = []
    for (let i = 0; i < ARMS; i++) {
      const a = armAngle(i)
      const w = 0.035
      for (let k = -1; k <= 1; k += 2) {
        const aa = a + k * w
        mk.push(Math.cos(a) * (DIAL_R + 0.55), 0, Math.sin(a) * (DIAL_R + 0.55), Math.cos(aa) * (DIAL_R + 1.0), 0, Math.sin(aa) * (DIAL_R + 1.0))
      }
    }
    const mg = new THREE.BufferGeometry()
    mg.setAttribute('position', new THREE.Float32BufferAttribute(mk, 3))
    const mm = new THREE.LineBasicMaterial({ color: C.hot, transparent: true, opacity: 0.9, depthWrite: false })
    const marks = new THREE.LineSegments(mg, mm)
    marks.position.y = -0.6
    this.scene.add(marks)
  }

  private buildArms() {
    const R = this.ring
    const n = ARMS * SEG * R
    this.bodyPos = new Float32Array(n * 3)
    this.bodyNrm = new Float32Array(n * 3)
    const aS = new Float32Array(n)
    const aArm = new Float32Array(n)
    let k = 0
    for (let i = 0; i < ARMS; i++)
      for (let j = 0; j < SEG; j++)
        for (let r = 0; r < R; r++) {
          aS[k] = j / (SEG - 1)
          aArm[k] = i
          k++
        }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.bodyPos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('normal', new THREE.BufferAttribute(this.bodyNrm, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aS', new THREE.BufferAttribute(aS, 1))
    g.setAttribute('aArm', new THREE.BufferAttribute(aArm, 1))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20)
    this.bodyGeo = g
    const mat = this.pointMaterial(
      /* glsl */ `
      ${POINT_SIZE}
      uniform float uTime;
      uniform float uArmAct[8];
      uniform vec3 uBone; uniform vec3 uHot;
      attribute float aS; attribute float aArm;
      varying vec3 vC; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vec3 vd = normalize(-mv.xyz);
        float rim = pow(1.0 - abs(dot(n, vd)), 1.7);
        float act = uArmAct[int(aArm + 0.5)];
        // a travelling shimmer down active arms
        float band = smoothstep(0.92, 1.0, sin(aS * 26.0 - uTime * 7.0)) * act;
        float a = mix(0.045, 0.62, rim) * (1.0 - 0.55 * smoothstep(0.7, 1.0, aS));
        vC = mix(uBone, uHot, clamp(act * 0.35 * (1.0 - aS) + band * 0.9, 0.0, 1.0));
        vA = a + band * 0.5;
        gl_PointSize = pointSize(0.045 + 0.04 * (1.0 - aS), mv);
        gl_Position = projectionMatrix * mv;
      }`,
      /* glsl */ `
      varying vec3 vC; varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        gl_FragColor = vec4(vC, vA * smoothstep(0.5, 0.15, d));
      }`,
      { uArmAct: this.uArmAct },
    )
    this.scene.add(new THREE.Points(g, mat))

    // silhouette lines (left/right edge of every arm)
    this.outlinePos = new Float32Array(ARMS * 2 * (SEG - 1) * 2 * 3)
    const og = new THREE.BufferGeometry()
    og.setAttribute('position', new THREE.BufferAttribute(this.outlinePos, 3).setUsage(THREE.DynamicDrawUsage))
    og.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20)
    this.outlineGeo = og
    const om = new THREE.LineBasicMaterial({ color: C.bone, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending })
    this.scene.add(new THREE.LineSegments(og, om))

    // decorative suckers: two rows on the underside
    for (let i = 0; i < ARMS; i++)
      for (let j = 5; j < SEG - 5; j += 2)
        for (const side of [-1, 1]) this.suckerIdx.push({ arm: i, j: j + (side > 0 ? 1 : 0), side })
    const ns = this.suckerIdx.length
    this.suckerPos = new Float32Array(ns * 3)
    const sS = new Float32Array(ns)
    this.suckerIdx.forEach((s, i) => (sS[i] = s.j / (SEG - 1)))
    const sg = new THREE.BufferGeometry()
    sg.setAttribute('position', new THREE.BufferAttribute(this.suckerPos, 3).setUsage(THREE.DynamicDrawUsage))
    sg.setAttribute('aS', new THREE.BufferAttribute(sS, 1))
    sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20)
    this.suckerGeo = sg
    const sm = this.pointMaterial(
      /* glsl */ `
      ${POINT_SIZE}
      attribute float aS;
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vA = 0.38 * (1.0 - aS * 0.7);
        gl_PointSize = pointSize(0.15 * (1.0 - aS * 0.85) + 0.03, mv);
        gl_Position = projectionMatrix * mv;
      }`,
      /* glsl */ `
      uniform vec3 uBone;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float ring = smoothstep(0.5, 0.42, d) * smoothstep(0.24, 0.32, d);
        if (ring < 0.01) discard;
        gl_FragColor = vec4(uBone, vA * ring);
      }`,
    )
    this.scene.add(new THREE.Points(sg, sm))

    // interbrachial web: the membrane between neighbouring arm bases
    const WEBJ = Math.round(SEG * 0.26)
    const M = 9
    for (let i = 0; i < ARMS; i++)
      for (let m = 1; m < M; m++) {
        const u = m / M
        const jmax = Math.round(WEBJ * (1 - 0.62 * Math.sin(Math.PI * u)))
        for (let j = 0; j <= jmax; j++) this.membraneIdx.push({ i, j, u })
      }
    const nm = this.membraneIdx.length
    this.membranePos = new Float32Array(nm * 3)
    const mEdge = new Float32Array(nm)
    this.membraneIdx.forEach((q, k) => {
      const jmax = Math.round(WEBJ * (1 - 0.62 * Math.sin(Math.PI * q.u)))
      mEdge[k] = q.j === jmax ? 1 : 0
    })
    const mg = new THREE.BufferGeometry()
    mg.setAttribute('position', new THREE.BufferAttribute(this.membranePos, 3).setUsage(THREE.DynamicDrawUsage))
    mg.setAttribute('aEdge', new THREE.BufferAttribute(mEdge, 1))
    mg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20)
    this.membraneGeo = mg
    const mm = this.pointMaterial(
      /* glsl */ `
      ${POINT_SIZE}
      attribute float aEdge;
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vA = 0.16 + aEdge * 0.42;
        gl_PointSize = pointSize(0.04 + aEdge * 0.025, mv);
        gl_Position = projectionMatrix * mv;
      }`,
      /* glsl */ `
      uniform vec3 uBone;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(uBone, vA * smoothstep(0.5, 0.1, d));
      }`,
    )
    this.scene.add(new THREE.Points(mg, mm))
  }

  private buildMantle() {
    const n = this.lowPower ? 1800 : 3400
    const pos = new Float32Array(n * 3)
    const golden = Math.PI * (3 - Math.sqrt(5))
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2
      const r = Math.sqrt(1 - y * y)
      const th = golden * i
      pos[i * 3] = Math.cos(th) * r
      pos[i * 3 + 1] = y
      pos[i * 3 + 2] = Math.sin(th) * r
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    const armDirs = new Float32Array(ARMS * 2)
    for (let i = 0; i < ARMS; i++) {
      armDirs[i * 2] = Math.cos(armAngle(i))
      armDirs[i * 2 + 1] = Math.sin(armAngle(i))
    }
    const mat = this.pointMaterial(
      /* glsl */ `
      ${POINT_SIZE}
      ${SNOISE}
      uniform float uTime;
      uniform float uHeat[8];
      uniform vec2 uArmDir[8];
      uniform vec3 uBone; uniform vec3 uHot;
      varying vec3 vC; varying float vA;
      void main() {
        vec3 d = normalize(position);
        float breathe = 1.0 + 0.035 * sin(uTime * 1.1);
        float n = snoise(d * 1.7 + vec3(0.0, uTime * 0.18, 0.0));
        float n2 = snoise(d * 5.0 - vec3(uTime * 0.3));
        float r = breathe * (1.0 + 0.07 * n + 0.018 * n2);
        // mantle: a bulbous dome, slightly elongated toward the back
        vec3 p = d * r * vec3(1.32, 1.0, 1.78);
        p.y = p.y * (p.y > 0.0 ? 1.3 : 0.38);
        // taper the back of the mantle like a real octopus head
        p.xy *= 1.0 - 0.22 * smoothstep(0.0, -1.8, p.z);
        p.z -= 0.95;
        p.y += 0.62;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec3 nn = normalize(normalMatrix * d);
        vec3 vd = normalize(-mv.xyz);
        float rim = pow(1.0 - abs(dot(nn, vd)), 1.5);
        // chromatophores: flash toward the arm that just fed the mantle
        float heat = 0.0;
        vec2 dxz = normalize(d.xz + 1e-4);
        for (int i = 0; i < 8; i++) {
          float k = max(0.0, dot(dxz, uArmDir[i]));
          heat += uHeat[i] * pow(k, 5.0);
        }
        float speck = step(0.62, fract(sin(dot(d, vec3(12.9898, 78.233, 37.719))) * 43758.5453));
        heat = clamp(heat, 0.0, 1.0);
        vC = mix(uBone, uHot, clamp(heat * (0.55 + 0.45 * speck) + 0.06, 0.0, 1.0));
        vA = mix(0.03, 0.68, rim) + heat * 0.5 * speck;
        gl_PointSize = pointSize(0.05 + heat * 0.05 * speck, mv);
        gl_Position = projectionMatrix * mv;
      }`,
      /* glsl */ `
      varying vec3 vC; varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(vC, vA * smoothstep(0.5, 0.1, d));
      }`,
      { uHeat: this.uHeat, uArmDir: { value: Array.from({ length: ARMS }, (_, i) => new THREE.Vector2(armDirs[i * 2], armDirs[i * 2 + 1])) } },
    )
    this.mantle = new THREE.Points(g, mat)
    this.scene.add(this.mantle)

    // eyes with horizontal slit pupils
    const cv = document.createElement('canvas')
    cv.width = cv.height = 128
    const x = cv.getContext('2d')!
    const grad = x.createRadialGradient(64, 64, 6, 64, 64, 62)
    grad.addColorStop(0, '#ffd9c2')
    grad.addColorStop(0.35, '#ff7a33')
    grad.addColorStop(0.8, '#ff4d00')
    grad.addColorStop(1, 'rgba(255,77,0,0)')
    x.fillStyle = grad
    x.beginPath()
    x.arc(64, 64, 62, 0, TAU)
    x.fill()
    // horizontal slit pupil, rounded ends
    x.fillStyle = '#050505'
    x.beginPath()
    x.ellipse(64, 64, 34, 6.5, 0, 0, TAU)
    x.fill()
    const tex = new THREE.CanvasTexture(cv)
    tex.colorSpace = THREE.SRGBColorSpace
    for (const side of [-1, 1]) {
      const sm = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
      const s = new THREE.Sprite(sm)
      s.position.set(side * 0.74, 1.18, 0.56)
      s.scale.set(0.3, 0.3, 1)
      s.renderOrder = 8
      this.eyes.push(s)
      this.scene.add(s)
    }
  }

  private buildWeb() {
    const n = this.webCap
    this.webPos = new Float32Array(n * 3)
    this.webSize = new Float32Array(n)
    this.webBirth = new Float32Array(n).fill(-1000)
    this.webKind = new Float32Array(n).fill(4)
    this.webSeed = new Float32Array(n)
    for (let i = 0; i < n; i++) this.webSeed[i] = Math.random()
    this.webUrl = new Array(n).fill(null)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.webPos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aSize', new THREE.BufferAttribute(this.webSize, 1).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aBirth', new THREE.BufferAttribute(this.webBirth, 1).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aKind', new THREE.BufferAttribute(this.webKind, 1).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.webSeed, 1))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30)
    this.webGeo = g
    const mat = this.pointMaterial(
      /* glsl */ `
      ${POINT_SIZE}
      uniform float uTime;
      uniform vec3 uBone; uniform vec3 uHot; uniform vec3 uErr; uniform vec3 uDim;
      attribute float aSize; attribute float aBirth; attribute float aKind; attribute float aSeed;
      varying vec3 vC; varying float vA;
      void main() {
        float age = uTime - aBirth;
        float sz = aSize;
        vec3 c = uDim; float a = 0.0;
        if (aKind < 0.5) {            // frontier
          c = uDim; a = 0.5 * smoothstep(0.0, 0.8, age);
          sz = 0.05;
        } else if (aKind < 1.5) {     // being fetched
          c = mix(uBone, uHot, 0.5 + 0.5 * sin(uTime * 10.0 + aSeed * 6.0)); a = 1.0;
          sz = 0.1;
        } else if (aKind < 2.5) {     // accepted page
          float f = exp(-max(age, 0.0) * 1.8);
          c = mix(uBone * 0.7, uHot, f); a = 0.55 + 0.45 * f;
          sz = aSize * (1.0 + 0.9 * f);
        } else if (aKind < 3.5) {     // rejected — burn out
          float f = clamp(age / 1.6, 0.0, 1.0);
          c = uErr; a = 1.0 - f; sz = 0.1 * (1.0 + 1.2 * f);
        }
        a *= 0.82 + 0.18 * sin(uTime * 1.3 + aSeed * 40.0);
        vC = c; vA = a;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (aKind > 3.5) ? 0.0 : pointSize(sz, mv);
        gl_Position = projectionMatrix * mv;
      }`,
      /* glsl */ `
      varying vec3 vC; varying float vA;
      void main() {
        if (vA < 0.01) discard;
        // square data points with a hairline inset
        vec2 c = abs(gl_PointCoord - 0.5);
        float m = max(c.x, c.y);
        float body = step(m, 0.5);
        gl_FragColor = vec4(vC, vA * body);
      }`,
    )
    this.scene.add(new THREE.Points(g, mat))

    // link edges
    const e = this.edgeCap
    this.edgePos = new Float32Array(e * 2 * 3)
    this.edgeBirth = new Float32Array(e * 2).fill(-1000)
    const eg = new THREE.BufferGeometry()
    eg.setAttribute('position', new THREE.BufferAttribute(this.edgePos, 3).setUsage(THREE.DynamicDrawUsage))
    eg.setAttribute('aBirth', new THREE.BufferAttribute(this.edgeBirth, 1).setUsage(THREE.DynamicDrawUsage))
    eg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30)
    this.edgeGeo = eg
    const em = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uTime, uBone: { value: C.bone }, uHot: { value: C.hot } },
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute float aBirth;
        varying float vA; varying float vF;
        void main() {
          float age = uTime - aBirth;
          vF = exp(-max(age, 0.0) * 2.2);
          vA = (aBirth < -500.0) ? 0.0 : (0.05 + 0.32 * vF) * smoothstep(0.0, 0.25, age + 0.001);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uBone; uniform vec3 uHot;
        varying float vA; varying float vF;
        void main() { gl_FragColor = vec4(mix(uBone, uHot, vF), vA); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.scene.add(new THREE.LineSegments(eg, em))
  }

  private buildAgents() {
    this.markerPos = new Float32Array(MAX_AGENTS * 3)
    this.markerState = new Float32Array(MAX_AGENTS)
    this.markerSel = new Float32Array(MAX_AGENTS)
    this.markerAge = new Float32Array(MAX_AGENTS)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.markerPos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aState', new THREE.BufferAttribute(this.markerState, 1).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aSel', new THREE.BufferAttribute(this.markerSel, 1).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aAge', new THREE.BufferAttribute(this.markerAge, 1).setUsage(THREE.DynamicDrawUsage))
    g.setDrawRange(0, 0)
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20)
    this.markerGeo = g
    const mat = this.pointMaterial(
      /* glsl */ `
      ${POINT_SIZE}
      uniform float uTime;
      uniform vec3 uBone; uniform vec3 uHot; uniform vec3 uErr; uniform vec3 uDim;
      attribute float aState; attribute float aSel; attribute float aAge;
      varying vec3 vC; varying float vA; varying float vSel; varying float vActive;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 c = uDim; float a = 0.65; float sz = 0.2; float act = 0.0;
        if (aState < 0.5) { c = uDim; a = 0.7; }
        else if (aState < 1.5) { c = uBone; a = 0.55 + 0.45 * step(0.5, fract(uTime * 3.0)); }
        else if (aState < 2.5) { c = uHot; a = 1.0; sz = 0.3; act = 1.0; }
        else if (aState < 3.5) { c = uHot; a = 1.0; sz = 0.34 + 0.06 * sin(uTime * 14.0); act = 1.0; }
        else if (aState < 4.5) { c = mix(uHot, uBone, smoothstep(0.0, 0.5, aAge)); a = 1.0; sz = 0.4 * (1.0 + exp(-aAge * 3.0)); act = 1.0; }
        else if (aState < 5.5) { c = uErr; a = 1.0; sz = 0.3; }
        else { c = uDim; a = 0.4; }
        sz *= 1.0 + aSel * 0.6;
        vC = c; vA = a; vSel = aSel; vActive = act;
        gl_PointSize = pointSize(sz, mv);
        gl_Position = projectionMatrix * mv;
      }`,
      /* glsl */ `
      uniform float uTime;
      varying vec3 vC; varying float vA; varying float vSel; varying float vActive;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float ring = smoothstep(0.5, 0.44, d) * smoothstep(0.30, 0.36, d);
        float core = smoothstep(0.2, 0.1, d) * (0.4 + 0.6 * vActive);
        float sel = vSel * smoothstep(0.5, 0.47, d) * step(0.44, d) * step(0.5, fract(atan(gl_PointCoord.y - 0.5, gl_PointCoord.x - 0.5) * 1.27 + uTime * 0.5));
        float a = max(max(ring, core), sel);
        if (a < 0.01) discard;
        gl_FragColor = vec4(vC, vA * a);
      }`,
    )
    const pts = new THREE.Points(g, mat)
    pts.renderOrder = 5
    this.scene.add(pts)

    // filaments
    const segs = MAX_AGENTS * FIL_SEG
    this.filPos = new Float32Array(segs * 2 * 3)
    const aU = new Float32Array(segs * 2)
    const aAg = new Float32Array(segs * 2)
    for (let a = 0; a < MAX_AGENTS; a++)
      for (let s = 0; s < FIL_SEG; s++) {
        const i = (a * FIL_SEG + s) * 2
        aU[i] = s / FIL_SEG
        aU[i + 1] = (s + 1) / FIL_SEG
        aAg[i] = aAg[i + 1] = a
      }
    const fg = new THREE.BufferGeometry()
    fg.setAttribute('position', new THREE.BufferAttribute(this.filPos, 3).setUsage(THREE.DynamicDrawUsage))
    fg.setAttribute('aU', new THREE.BufferAttribute(aU, 1))
    fg.setAttribute('aAgent', new THREE.BufferAttribute(aAg, 1))
    fg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30)
    this.filGeo = fg
    const fm = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uTime,
        uExt: this.uFilExt,
        uKind: this.uFilKind,
        uAlpha: this.uFilAlpha,
        uBone: { value: C.bone },
        uHot: { value: C.hot },
        uErr: { value: C.err },
      },
      vertexShader: /* glsl */ `
        uniform float uExt[${MAX_AGENTS}];
        uniform float uKind[${MAX_AGENTS}];
        uniform float uAlpha[${MAX_AGENTS}];
        attribute float aU; attribute float aAgent;
        varying float vU; varying float vExt; varying float vKind; varying float vAlpha;
        void main() {
          int i = int(aAgent + 0.5);
          vU = aU; vExt = uExt[i]; vKind = uKind[i]; vAlpha = uAlpha[i];
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uBone; uniform vec3 uHot; uniform vec3 uErr;
        varying float vU; varying float vExt; varying float vKind; varying float vAlpha;
        void main() {
          if (vKind < 0.5 || vU > vExt || vAlpha < 0.01) discard;
          vec3 c = uHot; float a = vAlpha;
          if (vKind < 1.5) {               // fetch — dashes flow outward
            a *= 0.35 + 0.65 * step(0.45, fract(vU * 14.0 - uTime * 3.0));
          } else if (vKind < 2.5) {        // work — solid, pulsing
            a *= 0.7 + 0.3 * sin(uTime * 12.0 - vU * 20.0);
          } else if (vKind < 3.5) {        // store — cooling to bone
            c = mix(uHot, uBone, 0.6);
          } else {                         // reject
            c = uErr;
          }
          // brighter near the sucker
          a *= 0.55 + 0.45 * (1.0 - vU);
          gl_FragColor = vec4(c, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const fl = new THREE.LineSegments(fg, fm)
    fl.renderOrder = 4
    this.scene.add(fl)
  }

  private buildPackets() {
    this.packetPos = new Float32Array(MAX_PACKETS * 3)
    this.packetAlpha = new Float32Array(MAX_PACKETS)
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.packetPos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.packetAlpha, 1).setUsage(THREE.DynamicDrawUsage))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30)
    this.packetGeo = g
    const mat = this.pointMaterial(
      /* glsl */ `
      ${POINT_SIZE}
      attribute float aAlpha;
      varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vA = aAlpha;
        gl_PointSize = aAlpha > 0.0 ? pointSize(0.2, mv) : 0.0;
        gl_Position = projectionMatrix * mv;
      }`,
      /* glsl */ `
      uniform vec3 uHot; uniform vec3 uBone;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float core = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(mix(uHot, uBone, core * core), vA * core);
      }`,
    )
    const p = new THREE.Points(g, mat)
    p.renderOrder = 6
    this.scene.add(p)
  }

  private buildAtmosphere() {
    // marine snow: slow drifting specks for depth
    const n = this.lowPower ? 700 : 1600
    const pos = new Float32Array(n * 3)
    const seed = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const r = 3 + Math.sqrt(Math.random()) * 15
      const a = Math.random() * TAU
      pos[i * 3] = Math.cos(a) * r
      pos[i * 3 + 1] = -3 + Math.random() * 9
      pos[i * 3 + 2] = Math.sin(a) * r
      seed[i] = Math.random()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30)
    const m = this.pointMaterial(
      /* glsl */ `
      ${POINT_SIZE}
      uniform float uTime;
      attribute float aSeed;
      varying float vA;
      void main() {
        vec3 p = position;
        float t = uTime * (0.05 + aSeed * 0.08);
        p.y = mod(p.y - t * 2.0 + 3.0, 9.0) - 3.0;
        p.x += sin(uTime * 0.2 + aSeed * 40.0) * 0.35;
        p.z += cos(uTime * 0.17 + aSeed * 31.0) * 0.35;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vA = (0.05 + 0.1 * aSeed) * smoothstep(-3.0, -1.5, p.y) * (1.0 - smoothstep(4.5, 6.0, p.y));
        gl_PointSize = pointSize(0.035 + aSeed * 0.03, mv);
        gl_Position = projectionMatrix * mv;
      }`,
      /* glsl */ `
      uniform vec3 uBone;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(uBone, vA * smoothstep(0.5, 0.0, d));
      }`,
    )
    this.scene.add(new THREE.Points(g, m))
  }

  private ringGeo: THREE.BufferGeometry | null = null

  private pulse(at: THREE.Vector3, r0: number, r1: number, life: number, base: number, color: THREE.Color) {
    if (this.rings.length > 24) return
    if (!this.ringGeo) {
      const pts: number[] = []
      for (let i = 0; i < 128; i++) {
        const a = (i / 128) * TAU
        pts.push(Math.cos(a), 0, Math.sin(a))
      }
      this.ringGeo = new THREE.BufferGeometry()
      this.ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    }
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: base, depthWrite: false, blending: THREE.AdditiveBlending })
    const line = new THREE.LineLoop(this.ringGeo, mat)
    line.position.copy(at)
    line.scale.setScalar(r0)
    this.scene.add(line)
    this.rings.push({ line, born: this.time, life, r0, r1, base, at: at.clone() })
  }

  private updateRings() {
    if (this.time > this.nextSweep) {
      this.nextSweep = this.time + 6.5
      this.pulse(new THREE.Vector3(0, -0.58, 0), 0.8, DIAL_R + 0.5, 4.2, 0.55, C.hot)
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]
      const k = (this.time - r.born) / r.life
      if (k >= 1) {
        this.scene.remove(r.line)
        ;(r.line.material as THREE.Material).dispose()
        this.rings.splice(i, 1)
        continue
      }
      const e = 1 - Math.pow(1 - k, 2.2)
      r.line.scale.setScalar(r.r0 + (r.r1 - r.r0) * e)
      ;(r.line.material as THREE.LineBasicMaterial).opacity = r.base * (1 - k) * (1 - k)
    }
  }

  // ─── web graph ─────────────────────────────────────────────────

  private domainFor(host: string, sectorHint: number): Domain {
    const h = host.replace(/^www\./, '')
    let d = this.domains.get(h)
    if (d) return d
    const known = this.knownDomains.get(h) ?? this.knownDomains.get('www.' + h)
    const sector = known?.sector ?? sectorForHost(h, sectorHint)
    const a = armAngle(sector) + (h01(h) - 0.5) * (TAU / ARMS) * 0.74
    const r = WEB_IN + 0.7 + Math.pow(h01(h + '#r'), 0.8) * (WEB_OUT - WEB_IN - 1.1)
    d = {
      host: h,
      sector,
      center: new THREE.Vector3(Math.cos(a) * r, (h01(h + '#y') - 0.5) * 1.1 - 0.25, Math.sin(a) * r),
      count: known?.pages ?? 0,
      frontier: known?.frontier ?? 0,
      discovered: known?.discovered ?? false,
      bornAt: this.time,
    }
    this.domains.set(h, d)
    return d
  }

  private sizeForTokens(tokens: number) {
    return 0.055 + Math.min(0.08, Math.log10(1 + tokens) * 0.02)
  }

  private addNode(url: string, kind: number, sectorHint: number, birth: number): number {
    const existing = this.urlIndex.get(url)
    if (existing !== undefined) {
      this.setKind(existing, kind, birth)
      return existing
    }
    const host = url.includes('#f') && !url.startsWith('http') ? url.split('#')[0] : hostOf(url)
    const dom = this.domainFor(host, sectorHint)
    const idx = this.webNext
    this.webNext = (this.webNext + 1) % this.webCap
    const old = this.webUrl[idx]
    if (old) this.urlIndex.delete(old)
    this.webUrl[idx] = url
    this.urlIndex.set(url, idx)
    const spread = 0.28 + Math.min(1.25, Math.sqrt(dom.count + dom.frontier * 0.25) * 0.075)
    const a = h01(url) * TAU
    const rr = Math.pow(h01(url + '#d'), 0.6) * spread
    this.webPos[idx * 3] = dom.center.x + Math.cos(a) * rr
    this.webPos[idx * 3 + 1] = dom.center.y + (h01(url + '#h') - 0.5) * spread * 0.5
    this.webPos[idx * 3 + 2] = dom.center.z + Math.sin(a) * rr
    this.webKind[idx] = kind
    this.webBirth[idx] = birth
    this.webSize[idx] = kind === 2 ? 0.1 : 0.05
    this.webDirty = true
    return idx
  }

  private setKind(idx: number, kind: number, birth = this.time) {
    // never downgrade an accepted page back to frontier
    if (this.webKind[idx] === 2 && kind === 0) return
    this.webKind[idx] = kind
    this.webBirth[idx] = birth
    this.webDirty = true
  }

  private addEdge(a: number, b: number, birth: number) {
    const i = this.edgeNext
    this.edgeNext = (this.edgeNext + 1) % this.edgeCap
    for (let k = 0; k < 3; k++) {
      this.edgePos[i * 6 + k] = this.webPos[a * 3 + k]
      this.edgePos[i * 6 + 3 + k] = this.webPos[b * 3 + k]
    }
    this.edgeBirth[i * 2] = birth
    this.edgeBirth[i * 2 + 1] = birth
    this.edgeDirty = true
  }

  // ─── agents ────────────────────────────────────────────────────

  private onState(v: AgentVis, a: AgentInfo) {
    const st = a.state
    v.state = st
    v.stateAt = this.time
    switch (st) {
      case 'fetch': {
        if (!a.url) break
        v.nodeIdx = this.addNode(a.url, 1, a.sector, this.time)
        v.fil = 1
        v.ext = 0
        v.extTarget = 1
        v.alpha = 1
        break
      }
      case 'parse':
      case 'taste':
      case 'dedupe':
        if (v.nodeIdx < 0 && a.url) v.nodeIdx = this.addNode(a.url, 1, a.sector, this.time)
        v.fil = 2
        v.extTarget = 1
        v.alpha = 1
        break
      case 'store':
        if (v.nodeIdx >= 0) {
          v.fil = 3
          this.spawnPacket(v)
        }
        break
      case 'reject':
      case 'error':
        if (v.nodeIdx >= 0) this.setKind(v.nodeIdx, 3)
        v.fil = 4
        v.extTarget = 0
        break
      default:
        if (v.fil !== 0) v.extTarget = 0
        v.nodeIdx = st === 'seek' ? v.nodeIdx : -1
        break
    }
  }

  private suckerJ(slot: number): number {
    const s = 0.2 + Math.min(7, slot) * 0.1
    return Math.round(s * (SEG - 1))
  }

  private suckerWorld(arm: number, j: number, side: number, out: THREE.Vector3) {
    const p = this.spine[arm]
    const B = this.frameB[arm]
    const N = this.frameN[arm]
    const r = this.radius[j]
    out.set(
      p[j * 3] - N[j * 3] * r * 0.5 + B[j * 3] * side * r * 0.35,
      p[j * 3 + 1] - N[j * 3 + 1] * r * 0.5 + B[j * 3 + 1] * side * r * 0.35,
      p[j * 3 + 2] - N[j * 3 + 2] * r * 0.5 + B[j * 3 + 2] * side * r * 0.35,
    )
    return out
  }

  private nodeWorld(idx: number, out: THREE.Vector3) {
    return out.set(this.webPos[idx * 3], this.webPos[idx * 3 + 1], this.webPos[idx * 3 + 2])
  }

  private bezier(p0: THREE.Vector3, p1: THREE.Vector3, u: number, out: THREE.Vector3, bend = 1) {
    const dist = p0.distanceTo(p1)
    // control point: lifted, and pushed sideways so reaches curve like tentacles from above
    const dx = p1.x - p0.x
    const dz = p1.z - p0.z
    const inv = 1 / (Math.hypot(dx, dz) || 1)
    const side = dist * 0.2 * bend
    const cx = (p0.x + p1.x) * 0.5 - dz * inv * side
    const cy = (p0.y + p1.y) * 0.5 + dist * 0.12
    const cz = (p0.z + p1.z) * 0.5 + dx * inv * side
    const iu = 1 - u
    out.set(
      iu * iu * p0.x + 2 * iu * u * cx + u * u * p1.x,
      iu * iu * p0.y + 2 * iu * u * cy + u * u * p1.y,
      iu * iu * p0.z + 2 * iu * u * cz + u * u * p1.z,
    )
    return out
  }

  private spawnPacket(v: AgentVis) {
    let p = this.packets.find((x) => !x.alive)
    if (!p) {
      if (this.packets.length >= MAX_PACKETS) return
      p = { agent: 0, arm: 0, j: 0, phase: 0, t: 0, alive: false, from: new THREE.Vector3() }
      this.packets.push(p)
    }
    p.agent = v.info.id
    p.arm = v.info.sector % ARMS
    p.j = this.suckerJ(v.info.slot)
    p.phase = 0
    p.t = 0
    p.alive = true
    this.nodeWorld(v.nodeIdx, p.from)
  }

  // ─── labels ────────────────────────────────────────────────────

  private flash(text: string, pos: THREE.Vector3, seconds: number) {
    if (!this.labelLayer || !this.opts.labels) return
    const el = document.createElement('div')
    el.className = 'cl-flash'
    el.textContent = text
    this.labelLayer.appendChild(el)
    this.flashLabels.push({ el, pos: pos.clone(), until: this.time + seconds })
  }

  private project(p: THREE.Vector3, out: THREE.Vector2): boolean {
    this.tmpV2.copy(p).project(this.camera)
    out.set((this.tmpV2.x * 0.5 + 0.5) * this.width, (-this.tmpV2.y * 0.5 + 0.5) * this.height)
    return this.tmpV2.z < 1
  }

  private updateLabels() {
    if (!this.labelLayer || !this.opts.labels) return
    const v2 = new THREE.Vector2()
    // sector labels on the dial
    for (let i = 0; i < ARMS; i++) {
      const el = this.sectorLabels[i]
      if (!el) continue
      const a = armAngle(i)
      this.tmpV.set(Math.cos(a) * (DIAL_R + 1.7), -0.6, Math.sin(a) * (DIAL_R + 1.7))
      const ok = this.project(this.tmpV, v2)
      el.style.transform = `translate3d(${v2.x.toFixed(1)}px, ${v2.y.toFixed(1)}px, 0) translate(-50%, -50%)`
      el.style.opacity = ok ? '1' : '0'
      const cnt = el.lastElementChild as HTMLElement
      const n = this.sectorCounts[i]
      const txt = n == null ? '—' : n.toLocaleString('en-US')
      if (cnt.textContent !== txt) cnt.textContent = txt
      el.classList.toggle('act', this.uArmAct.value[i] > 0.25)
    }
    // biggest domains (refresh membership ~2x/s)
    this.labelTick++
    if (this.labelTick % 30 === 1) {
      const top = [...this.domains.values()].sort((a, b) => b.count - a.count).slice(0, this.domainLabels.length)
      this.domainLabels.forEach((el, i) => {
        const d = top[i]
        el.dataset.host = d ? d.host : ''
        el.innerHTML = d ? `<b>${d.host}</b> <span class="num">${d.count}</span>` : ''
        el.style.display = d ? '' : 'none'
      })
    }
    for (const el of this.domainLabels) {
      const host = el.dataset.host
      if (!host) continue
      const d = this.domains.get(host)
      if (!d) continue
      this.tmpV.copy(d.center)
      this.tmpV.y += 0.35
      const ok = this.project(this.tmpV, v2)
      el.style.transform = `translate3d(${v2.x.toFixed(1)}px, ${v2.y.toFixed(1)}px, 0) translate(-50%, -100%)`
      el.style.opacity = ok ? '' : '0'
    }
    // selected / hovered agent tag
    const focus = this.hovered ?? this.selected
    const al = this.agentLabel
    if (al) {
      const v = focus !== null ? this.agents.get(focus) : undefined
      if (v && v.onScreen) {
        const a = v.info
        const st = a.state.toUpperCase()
        const host = a.host ? a.host.replace(/^www\./, '') : '—'
        const html = `<span class="cl-code">${a.code}</span><span class="cl-n">${a.name}</span><span class="cl-st st-${a.state}">${st}</span><span class="cl-host">${host}</span>`
        if (al.dataset.html !== html) {
          al.innerHTML = html
          al.dataset.html = html
        }
        al.style.transform = `translate3d(${(v.screen.x + 14).toFixed(1)}px, ${(v.screen.y - 14).toFixed(1)}px, 0)`
        al.style.opacity = '1'
      } else al.style.opacity = '0'
    }
    // transient flashes
    for (let i = this.flashLabels.length - 1; i >= 0; i--) {
      const f = this.flashLabels[i]
      if (this.time > f.until) {
        f.el.remove()
        this.flashLabels.splice(i, 1)
        continue
      }
      this.project(f.pos, v2)
      f.el.style.transform = `translate3d(${v2.x.toFixed(1)}px, ${v2.y.toFixed(1)}px, 0) translate(-50%, -50%)`
    }
  }

  // ─── frame ─────────────────────────────────────────────────────

  private start() {
    if (this.running || this.disposed) return
    this.running = true
    this.clock.getDelta()
    const loop = () => {
      if (this.disposed) return
      if (!this.visible || document.hidden) {
        this.running = false
        return
      }
      this.raf = requestAnimationFrame(loop)
      this.frame()
    }
    this.raf = requestAnimationFrame(loop)
  }

  private frame() {
    const dt = Math.min(0.05, this.clock.getDelta())
    this.time += dt
    const t = this.time
    this.uTime.value = t

    this.updateArmTargets(dt)
    this.updateSpines(t)
    this.writeArms()
    this.updateAgents(dt)
    this.updatePackets(dt)
    this.updateRings()

    // heat decay
    const heat = this.uHeat.value
    for (let i = 0; i < ARMS; i++) heat[i] *= Math.exp(-dt * 1.6)

    // eyes blink
    if (t > this.blinkAt) {
      const k = (t - this.blinkAt) / 0.16
      const s = k < 1 ? Math.abs(1 - 2 * k) : 1
      for (const e of this.eyes) e.scale.set(0.3, 0.3 * Math.max(0.08, s), 1)
      if (k >= 1) this.blinkAt = t + 2.5 + Math.random() * 5
    }

    if (this.webDirty) {
      const g = this.webGeo
      g.attributes.position.needsUpdate = true
      g.attributes.aSize.needsUpdate = true
      g.attributes.aBirth.needsUpdate = true
      g.attributes.aKind.needsUpdate = true
      this.webDirty = false
    }
    if (this.edgeDirty) {
      this.edgeGeo.attributes.position.needsUpdate = true
      this.edgeGeo.attributes.aBirth.needsUpdate = true
      this.edgeDirty = false
    }

    // camera
    const v = VARIANTS[this.opts.variant]
    this.pointerSmooth.lerp(this.pointer, 0.04)
    if (this.controls) {
      this.controls.update()
    } else {
      const base = new THREE.Vector3(...v.pos)
      const ang = t * v.spin
      const r = Math.hypot(base.x, base.z)
      this.camera.position.set(
        Math.sin(ang) * r + this.pointerSmooth.x * 1.6,
        base.y - this.pointerSmooth.y * 1.2,
        Math.cos(ang) * r,
      )
      this.camera.lookAt(new THREE.Vector3(...v.target))
    }

    this.composer.render()
    this.updateLabels()
  }

  private updateArmTargets(dt: number) {
    const sum = new Float32Array(ARMS)
    const sx = new Float32Array(ARMS)
    const sz = new Float32Array(ARMS)
    for (const v of this.agents.values()) {
      const arm = v.info.sector % ARMS
      const code = STATE_CODE[v.state]
      if (code >= 2 && code <= 4 && v.nodeIdx >= 0) {
        sum[arm] += 1
        sx[arm] += this.webPos[v.nodeIdx * 3]
        sz[arm] += this.webPos[v.nodeIdx * 3 + 2]
      }
    }
    const act = this.uArmAct.value
    for (let i = 0; i < ARMS; i++) {
      const target = Math.min(1, sum[i] * 0.45)
      act[i] += (target - act[i]) * Math.min(1, dt * 3)
      if (sum[i] > 0) {
        const ang = Math.atan2(sz[i], sx[i])
        this.armReachAngle[i] = lerpAngle(this.armReachAngle[i] || armAngle(i), ang, Math.min(1, dt * 2))
      }
      const reachT = sum[i] > 0 ? 1 : 0
      this.armReach[i] += (reachT - this.armReach[i]) * Math.min(1, dt * 1.5)
    }
  }

  private updateSpines(t: number) {
    const L = 5.9
    const ds = 1 / (SEG - 1)
    for (let i = 0; i < ARMS; i++) {
      const p = this.spine[i]
      const a0 = armAngle(i)
      const ph = i * 1.71
      const reach = this.armReach[i]
      const curlAmp = 0.9 + 0.35 * Math.sin(t * 0.31 + i * 1.3)
      const tipCurl = (i % 2 ? 1 : -1) * (4.2 + 2.2 * Math.sin(t * 0.23 + i * 2.1)) * (1 - reach * 0.75)
      const len = L * (1 + 0.035 * Math.sin(t * 0.5 + i) + reach * 0.1)
      let dir = a0 + 0.12 * Math.sin(t * 0.4 + ph)
      let x = Math.cos(a0) * HUB_R
      let z = Math.sin(a0) * HUB_R
      for (let j = 0; j < SEG; j++) {
        const s = j * ds
        const y = 0.1 + 0.11 * Math.sin(TAU * (0.75 * s - 0.11 * t) + ph) * s - 0.3 * s * s + reach * 0.32 * s * s
        p[j * 3] = x
        p[j * 3 + 1] = y
        p[j * 3 + 2] = z
        // curvature: travelling wave + curling tip, bent toward the reach target
        const wave = curlAmp * Math.sin(TAU * (1.15 * s - 0.16 * t) + ph) * (0.25 + s)
        const curl = tipCurl * Math.pow(s, 2.6)
        dir += (wave + curl) * ds * 1.15
        if (reach > 0.01) dir = lerpAngle(dir, this.armReachAngle[i], reach * 0.06 * (0.3 + s))
        const step = len * ds
        x += Math.cos(dir) * step
        z += Math.sin(dir) * step
      }
      // frames
      const B = this.frameB[i]
      const N = this.frameN[i]
      for (let j = 0; j < SEG; j++) {
        const j0 = Math.max(0, j - 1)
        const j1 = Math.min(SEG - 1, j + 1)
        let tx = p[j1 * 3] - p[j0 * 3]
        let ty = p[j1 * 3 + 1] - p[j0 * 3 + 1]
        let tz = p[j1 * 3 + 2] - p[j0 * 3 + 2]
        const tl = Math.hypot(tx, ty, tz) || 1
        tx /= tl
        ty /= tl
        tz /= tl
        // B = T × up
        let bx = -tz
        let by = 0
        let bz = tx
        const bl = Math.hypot(bx, by, bz) || 1
        bx /= bl
        by /= bl
        bz /= bl
        // N = B × T
        const nx = by * tz - bz * ty
        const ny = bz * tx - bx * tz
        const nz = bx * ty - by * tx
        B[j * 3] = bx
        B[j * 3 + 1] = by
        B[j * 3 + 2] = bz
        N[j * 3] = nx
        N[j * 3 + 1] = ny
        N[j * 3 + 2] = nz
      }
    }
  }

  private writeArms() {
    const R = this.ring
    const pos = this.bodyPos
    const nrm = this.bodyNrm
    let k = 0
    for (let i = 0; i < ARMS; i++) {
      const p = this.spine[i]
      const B = this.frameB[i]
      const N = this.frameN[i]
      for (let j = 0; j < SEG; j++) {
        const r = this.radius[j]
        const off = (j % 2) * (Math.PI / R)
        for (let q = 0; q < R; q++) {
          const ph = (q / R) * TAU + off
          const c = Math.cos(ph)
          const s = Math.sin(ph)
          const nx = B[j * 3] * c + N[j * 3] * s
          const ny = B[j * 3 + 1] * c + N[j * 3 + 1] * s
          const nz = B[j * 3 + 2] * c + N[j * 3 + 2] * s
          pos[k * 3] = p[j * 3] + B[j * 3] * c * r + N[j * 3] * s * r * 0.62
          pos[k * 3 + 1] = p[j * 3 + 1] + B[j * 3 + 1] * c * r + N[j * 3 + 1] * s * r * 0.62
          pos[k * 3 + 2] = p[j * 3 + 2] + B[j * 3 + 2] * c * r + N[j * 3 + 2] * s * r * 0.62
          nrm[k * 3] = nx
          nrm[k * 3 + 1] = ny
          nrm[k * 3 + 2] = nz
          k++
        }
      }
    }
    this.bodyGeo.attributes.position.needsUpdate = true
    this.bodyGeo.attributes.normal.needsUpdate = true

    // outlines
    const o = this.outlinePos
    let m = 0
    for (let i = 0; i < ARMS; i++) {
      const p = this.spine[i]
      const B = this.frameB[i]
      for (const side of [-1, 1]) {
        for (let j = 0; j < SEG - 1; j++) {
          for (const jj of [j, j + 1]) {
            const r = this.radius[jj] * side * 1.02
            o[m++] = p[jj * 3] + B[jj * 3] * r
            o[m++] = p[jj * 3 + 1] + B[jj * 3 + 1] * r
            o[m++] = p[jj * 3 + 2] + B[jj * 3 + 2] * r
          }
        }
      }
    }
    this.outlineGeo.attributes.position.needsUpdate = true

    // membrane
    const mp = this.membranePos
    for (let k = 0; k < this.membraneIdx.length; k++) {
      const q = this.membraneIdx[k]
      const a = this.spine[q.i]
      const b = this.spine[(q.i + 1) % ARMS]
      const j = q.j
      // sag the membrane slightly below the arms and inward
      const sag = Math.sin(Math.PI * q.u)
      mp[k * 3] = a[j * 3] * (1 - q.u) + b[j * 3] * q.u
      mp[k * 3 + 1] = a[j * 3 + 1] * (1 - q.u) + b[j * 3 + 1] * q.u - 0.08 * sag
      mp[k * 3 + 2] = a[j * 3 + 2] * (1 - q.u) + b[j * 3 + 2] * q.u
      const shrink = 1 - 0.1 * sag
      mp[k * 3] *= shrink
      mp[k * 3 + 2] *= shrink
    }
    this.membraneGeo.attributes.position.needsUpdate = true

    // suckers
    const sp = this.suckerPos
    for (let n = 0; n < this.suckerIdx.length; n++) {
      const s = this.suckerIdx[n]
      this.suckerWorld(s.arm, s.j, s.side, this.tmpV)
      sp[n * 3] = this.tmpV.x
      sp[n * 3 + 1] = this.tmpV.y
      sp[n * 3 + 2] = this.tmpV.z
    }
    this.suckerGeo.attributes.position.needsUpdate = true
  }

  private updateAgents(dt: number) {
    let n = 0
    const ext = this.uFilExt.value
    const kind = this.uFilKind.value
    const alpha = this.uFilAlpha.value
    ext.fill(0)
    kind.fill(0)
    alpha.fill(0)
    const p0 = new THREE.Vector3()
    const p1 = new THREE.Vector3()
    const q = new THREE.Vector3()
    for (const v of this.agents.values()) {
      if (n >= MAX_AGENTS) break
      const a = v.info
      const arm = a.sector % ARMS
      const j = this.suckerJ(a.slot)
      const side = a.slot % 2 ? 1 : -1
      this.suckerWorld(arm, j, side, v.pos)
      v.onScreen = this.project(v.pos, v.screen)
      this.markerPos[n * 3] = v.pos.x
      this.markerPos[n * 3 + 1] = v.pos.y
      this.markerPos[n * 3 + 2] = v.pos.z
      this.markerState[n] = STATE_CODE[v.state]
      this.markerSel[n] = a.id === this.selected || a.id === this.hovered ? 1 : 0
      this.markerAge[n] = this.time - v.stateAt

      // filament
      v.ext += (v.extTarget - v.ext) * Math.min(1, dt * (v.extTarget > v.ext ? 5.5 : 9))
      if (v.fil === 3) v.alpha = Math.max(0, v.alpha - dt * 1.1)
      if ((v.extTarget === 0 && v.ext < 0.02) || (v.fil === 3 && v.alpha <= 0)) {
        v.fil = 0
        v.ext = 0
        if (v.state !== 'fetch' && v.state !== 'parse' && v.state !== 'taste' && v.state !== 'dedupe') v.nodeIdx = -1
      }
      if (v.fil !== 0 && v.nodeIdx >= 0) {
        ext[n] = v.ext
        kind[n] = v.fil
        alpha[n] = v.alpha * (a.id === this.selected ? 1 : 0.85)
        this.nodeWorld(v.nodeIdx, p1)
        p0.copy(v.pos)
        const base = n * FIL_SEG * 6
        const bend = a.id % 2 ? 1 : -1
        for (let s = 0; s < FIL_SEG; s++) {
          this.bezier(p0, p1, s / FIL_SEG, q, bend)
          this.filPos[base + s * 6] = q.x
          this.filPos[base + s * 6 + 1] = q.y
          this.filPos[base + s * 6 + 2] = q.z
          this.bezier(p0, p1, (s + 1) / FIL_SEG, q, bend)
          this.filPos[base + s * 6 + 3] = q.x
          this.filPos[base + s * 6 + 4] = q.y
          this.filPos[base + s * 6 + 5] = q.z
        }
      }
      n++
    }
    this.markerGeo.setDrawRange(0, n)
    this.markerGeo.attributes.position.needsUpdate = true
    this.markerGeo.attributes.aState.needsUpdate = true
    this.markerGeo.attributes.aSel.needsUpdate = true
    this.markerGeo.attributes.aAge.needsUpdate = true
    this.filGeo.attributes.position.needsUpdate = true
  }

  private updatePackets(dt: number) {
    const pos = this.packetPos
    const al = this.packetAlpha
    al.fill(0)
    const sp = new THREE.Vector3()
    const out = new THREE.Vector3()
    this.packets.forEach((p, i) => {
      if (!p.alive) return
      const v = this.agents.get(p.agent)
      if (p.phase === 0) {
        // node → sucker along the filament
        p.t += dt / 0.55
        if (v) {
          this.bezier(v.pos, p.from, 1 - Math.min(1, p.t), out, v.info.id % 2 ? 1 : -1)
        } else out.copy(p.from)
        if (p.t >= 1) {
          p.phase = 1
          p.t = 0
        }
      } else if (p.phase === 1) {
        // sucker → hub along the arm spine
        const dur = 0.25 + (p.j / SEG) * 0.75
        p.t += dt / dur
        const jf = p.j * (1 - Math.min(1, p.t))
        const j0 = Math.floor(jf)
        const j1 = Math.min(SEG - 1, j0 + 1)
        const f = jf - j0
        const s = this.spine[p.arm]
        out.set(
          s[j0 * 3] * (1 - f) + s[j1 * 3] * f,
          s[j0 * 3 + 1] * (1 - f) + s[j1 * 3 + 1] * f + 0.05,
          s[j0 * 3 + 2] * (1 - f) + s[j1 * 3 + 2] * f,
        )
        if (p.t >= 1) {
          p.phase = 2
          p.t = 0
        }
      } else {
        // hub → mantle core
        p.t += dt / 0.22
        const s = this.spine[p.arm]
        sp.set(s[0], s[1], s[2])
        out.lerpVectors(sp, this.tmpV.set(0, 0.9, -0.9), Math.min(1, p.t))
        if (p.t >= 1) {
          p.alive = false
          this.uHeat.value[p.arm] = Math.min(1.4, this.uHeat.value[p.arm] + 0.9)
          return
        }
      }
      pos[i * 3] = out.x
      pos[i * 3 + 1] = out.y
      pos[i * 3 + 2] = out.z
      al[i] = 1
    })
    this.packetGeo.setDrawRange(0, this.packets.length)
    this.packetGeo.attributes.position.needsUpdate = true
    this.packetGeo.attributes.aAlpha.needsUpdate = true
  }

  // ─── events ────────────────────────────────────────────────────

  private resize() {
    const r = this.el.getBoundingClientRect()
    this.width = Math.max(1, r.width)
    this.height = Math.max(1, r.height)
    const dpr = Math.min(window.devicePixelRatio || 1, this.lowPower ? 1.5 : 2)
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(this.width, this.height, false)
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(this.width, this.height)
    this.bloom.resolution.set(this.width * 0.5, this.height * 0.5)
    this.camera.aspect = this.width / this.height
    // keep the whole dial in frame on tall/narrow screens
    const v = VARIANTS[this.opts.variant]
    const narrow = this.camera.aspect < 1
    this.camera.fov = narrow ? v.fov / Math.max(0.55, this.camera.aspect) * 0.92 : v.fov
    this.camera.updateProjectionMatrix()
    this.uPixelRatio.value = dpr
    this.uScale.value = (this.height * 0.5) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)
  }

  private onPointerMove = (e: PointerEvent) => {
    const r = this.el.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    this.pointer.set((x / r.width) * 2 - 1, (y / r.height) * 2 - 1)
    if (!this.opts.interactive) return
    let best: number | null = null
    let bd = 18 * 18
    for (const v of this.agents.values()) {
      if (!v.onScreen) continue
      const dx = v.screen.x - x
      const dy = v.screen.y - y
      const d = dx * dx + dy * dy
      if (d < bd) {
        bd = d
        best = v.info.id
      }
    }
    if (best !== this.hovered) {
      this.hovered = best
      this.el.style.cursor = best !== null ? 'pointer' : ''
      this.opts.onHover?.(best)
    }
  }

  private onPointerLeave = () => {
    this.pointer.set(0, 0)
    if (this.hovered !== null) {
      this.hovered = null
      this.opts.onHover?.(null)
    }
  }

  private onClick = () => {
    if (this.hovered !== null) this.opts.onSelect?.(this.hovered)
  }

  private onVisibility = () => {
    if (!document.hidden) this.start()
  }
}
