/**
 * storm.js — Sandy IR: Single-storm particle field
 *
 * VIIRS infrared satellite aesthetic for Hurricane Sandy (Oct 26–29 2012).
 * No arrow heads — pure particle-trace system.
 * Colour palette: blue (ambient/1013 hPa) → cyan → green → yellow → orange → red (eye).
 *
 * New page at /storm.html — does not modify main.js or index.html.
 * Canvas: 2560 × 768
 */

import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ── Canvas ─────────────────────────────────────────────────────────────────────
const RENDER_W = 2560, RENDER_H = 768;
const HALF_W   = RENDER_W / 2, HALF_H = RENDER_H / 2;

// ── View window — zoomed in on Sandy's Atlantic track ──────────────────────────
// 100° lon × 60° lat.  Sandy at peak (~32°N 73°W) sits near canvas centre.
const VIEW = { lonMin: -120, lonMax: -20, latMin: 5, latMax: 65 };

// ── Particle / trail capacity ──────────────────────────────────────────────────
const MAX_PART  = 8000;
const TRAIL_MAX = 60;
const MAX_INST  = MAX_PART * TRAIL_MAX;   // 480 000 instances

// ── Live params ────────────────────────────────────────────────────────────────
const params = {
    partCount:      6000,
    flowSpeed:      0.12,
    lifeMin:        200,
    lifeMax:        600,
    trailSteps:     55,
    dotSize:        4.0,
    eyeSwirl:       3,       // uniform CCW rotation — reduced so arms dominate the structure
    numArms:        3,       // number of logarithmic spiral rainbands
    armPitch:       2.5,     // how tightly the arms wind (ln-spiral pitch factor)
    armStrength:    28,      // force pulling particles toward nearest arm
    intensityBoost: 2.2,     // scale pressure→colour depth
    fieldOpacity:   0.55,    // IR background texture opacity
    eyeGlow:        0.75,    // eye overlay opacity factor
    frameDuration:  240,     // animation ticks per 6-hourly ERA5 frame (~8 s @ 30 fps)
};

// Spiral arm phase — increments slowly each frame so arms drift with the storm rotation
let armPhase = 0;

// ── Sandy NHC best-track (6-hourly, Oct 26 00Z → Oct 29 18Z) ──────────────────
const SANDY_TRACK = [
    { lat: 15.8, lon: -75.4 },  // 000  Oct 26 00Z  TS forming near Jamaica
    { lat: 16.5, lon: -76.7 },  // 001
    { lat: 17.3, lon: -77.8 },  // 002
    { lat: 18.8, lon: -78.3 },  // 003  Cat 1
    { lat: 20.9, lon: -77.9 },  // 004  crossing Cuba
    { lat: 22.9, lon: -77.2 },  // 005
    { lat: 24.6, lon: -76.1 },  // 006
    { lat: 26.4, lon: -75.2 },  // 007
    { lat: 28.1, lon: -74.5 },  // 008  heading north
    { lat: 29.9, lon: -73.8 },  // 009
    { lat: 31.8, lon: -73.4 },  // 010
    { lat: 34.3, lon: -73.9 },  // 011  extratropical transition
    { lat: 36.5, lon: -74.0 },  // 012
    { lat: 38.0, lon: -74.0 },  // 013
    { lat: 39.4, lon: -74.0 },  // 014
    { lat: 40.6, lon: -74.0 },  // 015  landfall NJ ~23:30 UTC
];

function trackToWorld(lat, lon) {
    const x = (lon - VIEW.lonMin) / (VIEW.lonMax - VIEW.lonMin) * RENDER_W - HALF_W;
    const y = (lat - VIEW.latMin) / (VIEW.latMax - VIEW.latMin) * RENDER_H - HALF_H;
    return { x, y };
}

function currentStormWorld() {
    const t0 = SANDY_TRACK[frameIdx];
    const t1 = SANDY_TRACK[Math.min(frameIdx + 1, SANDY_TRACK.length - 1)];
    return trackToWorld(
        t0.lat + (t1.lat - t0.lat) * frameFrac,
        t0.lon + (t1.lon - t0.lon) * frameFrac
    );
}

// ── Frame animation state ──────────────────────────────────────────────────────
const allFrames    = [];
let   globalMaxSpd = 1;
let   frameIdx     = 0;
let   frameFrac    = 0;

// ── Renderer ───────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(RENDER_W, RENDER_H);
renderer.setClearColor(0x000005);
document.getElementById('canvas-frame').appendChild(renderer.domElement);

const camera  = new THREE.OrthographicCamera(-HALF_W, HALF_W, HALF_H, -HALF_H, -1, 1);
const scene   = new THREE.Scene();

const composer  = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(RENDER_W, RENDER_H), 0.0, 0.20, 0.70);
composer.addPass(bloomPass);

// ── Shaders ────────────────────────────────────────────────────────────────────
// IR satellite palette: 5-stop piecewise linear in RGB matching NOAA VIIRS enhanced-IR.
// t=0 → deep blue (ambient 1013 hPa / no cloud)
// t=1 → saturated red (deep low / cold high-altitude convection)
const vertexShader = /* glsl */ `
    attribute float iDepth;   // pressure depth: 0 = ambient/blue, 1 = deep low/red
    attribute float iAlpha;   // combined life + trail-age fade

    varying vec3  vColor;
    varying float vAlpha;

    vec3 irColor(float t) {
        t = clamp(t, 0.0, 1.0);
        // Muted filmic IR palette — desaturated tones, no pure primaries
        if (t < 0.15) return mix(vec3(0.02, 0.02, 0.06), vec3(0.10, 0.18, 0.38), t / 0.15);
        if (t < 0.32) return mix(vec3(0.10, 0.18, 0.38), vec3(0.14, 0.44, 0.52), (t - 0.15) / 0.17);
        if (t < 0.50) return mix(vec3(0.14, 0.44, 0.52), vec3(0.30, 0.56, 0.26), (t - 0.32) / 0.18);
        if (t < 0.65) return mix(vec3(0.30, 0.56, 0.26), vec3(0.82, 0.74, 0.14), (t - 0.50) / 0.15);
        if (t < 0.80) return mix(vec3(0.82, 0.74, 0.14), vec3(0.88, 0.36, 0.06), (t - 0.65) / 0.15);
        if (t < 0.92) return mix(vec3(0.88, 0.36, 0.06), vec3(0.75, 0.08, 0.05), (t - 0.80) / 0.12);
                      return mix(vec3(0.75, 0.08, 0.05), vec3(0.96, 0.92, 0.86), (t - 0.92) / 0.08);
    }

    void main() {
        vColor = irColor(iDepth);
        vAlpha = iAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    }
`;

const fragmentShader = /* glsl */ `
    varying vec3  vColor;
    varying float vAlpha;
    void main() { gl_FragColor = vec4(vColor, vAlpha); }
`;

// ── Wind / pressure data ───────────────────────────────────────────────────────
let windU, windV, windSpd, windW = 36, windH = 18;
let pressureGrid = null;
let hasPressure  = false;
let presFrameMin = 920;
let presFrameMax = 1030;
let vortGrid     = null;   // relative vorticity fallback when no pressure

// Maps radial distance from storm centre to a 0–1 IR depth.
// Innermost particles are red/orange; outermost are green/cyan.
function sampleDepth(dist) {
    const stormR = RENDER_W * 0.36;
    const raw    = Math.max(0, 1.0 - dist / stormR);
    return Math.min(1, raw * params.intensityBoost * 0.5);
}

function bilinear(px, py) {
    const lon = VIEW.lonMin + (px + HALF_W) / RENDER_W * (VIEW.lonMax - VIEW.lonMin);
    const lat = VIEW.latMin + (py + HALF_H) / RENDER_H * (VIEW.latMax - VIEW.latMin);
    const lonStep = 350 / (windW - 1);
    const latStep = 170 / (windH - 1);
    const gx = (lon + 175) / lonStep;
    const gy = (lat +  85) / latStep;
    const x0 = Math.max(0, Math.min(windW - 1, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(windH - 1, Math.floor(gy)));
    const x1 = Math.min(windW - 1, x0 + 1);
    const y1 = Math.min(windH - 1, y0 + 1);
    const fx = gx - x0, fy = gy - y0;
    const i00=y0*windW+x0, i10=y0*windW+x1, i01=y1*windW+x0, i11=y1*windW+x1;
    const bl = a => (a[i00]*(1-fx)+a[i10]*fx)*(1-fy) + (a[i01]*(1-fx)+a[i11]*fx)*fy;
    return {
        u:    bl(windU),
        v:    bl(windV),
        spd:  bl(windSpd),
        pres: pressureGrid ? bl(pressureGrid) : 0,
        vort: vortGrid     ? bl(vortGrid)     : 0,
    };
}

// ── Vorticity (fallback signal when no pressure data) ─────────────────────────
// ∂v/∂x − ∂u/∂y  — positive = cyclonic (CCW in NH) — strong for hurricane-scale rotation.
function computeVorticityGrid() {
    if (!windU || !windV) return;
    if (!vortGrid) vortGrid = new Float32Array(windH * windW);
    const gW = windW, gH = windH;
    const lonStep = 350 / (gW - 1), latStep = 170 / (gH - 1);
    const R = 6.371e6, dyM = latStep * Math.PI / 180 * R;
    let maxAbs = 1e-10;
    for (let iy = 0; iy < gH; iy++) {
        const lat = -85 + iy * latStep;
        const dxM = Math.max(0.01, Math.cos(lat * Math.PI / 180)) * lonStep * Math.PI / 180 * R;
        for (let ix = 0; ix < gW; ix++) {
            const ix0=Math.max(0,ix-1), ix1=Math.min(gW-1,ix+1);
            const iy0=Math.max(0,iy-1), iy1=Math.min(gH-1,iy+1);
            const dv_dx=(windV[iy*gW+ix1]-windV[iy*gW+ix0])/((ix1-ix0)*dxM);
            const du_dy=(windU[iy1*gW+ix]-windU[iy0*gW+ix])/((iy1-iy0)*dyM);
            vortGrid[iy*gW+ix]=dv_dx-du_dy;
            const abs=Math.abs(vortGrid[iy*gW+ix]);
            if (abs>maxAbs) maxAbs=abs;
        }
    }
    const norm=1/maxAbs;
    for (let i=0; i<gH*gW; i++) vortGrid[i]=Math.max(0, vortGrid[i]*norm);
}

// ── Geostrophic wind from pressure ────────────────────────────────────────────
// u_g = −(1/ρf) ∂p/∂y,  v_g = +(1/ρf) ∂p/∂x
// Flows CCW around NH lows — gives correct spiral structure even with ERA5's
// surface-friction bias removed.
function computeGeostrophicWind() {
    if (!hasPressure || !pressureGrid) return;
    const gW=windW, gH=windH;
    const latStep=170/(gH-1), lonStep=350/(gW-1);
    const R=6.371e6, OMEGA=7.2921e-5, RHO=1.225;
    const dy=latStep*Math.PI/180*R;
    const F_MIN=2*OMEGA*Math.sin(10*Math.PI/180);
    let maxSpd=0;
    for (let iy=0; iy<gH; iy++) {
        const lat=-85+iy*latStep, latRad=lat*Math.PI/180;
        const dx=Math.max(0.01,Math.cos(latRad))*lonStep*Math.PI/180*R;
        const f=2*OMEGA*Math.sin(latRad);
        const fC=(f>=0?1:-1)*Math.max(Math.abs(f),F_MIN);
        const inv_rf=1/(RHO*fC);
        for (let ix=0; ix<gW; ix++) {
            const iy0=Math.max(0,iy-1), iy1=Math.min(gH-1,iy+1);
            const ix0=Math.max(0,ix-1), ix1=Math.min(gW-1,ix+1);
            const dp_dy=(pressureGrid[iy1*gW+ix]-pressureGrid[iy0*gW+ix])/((iy1-iy0)*dy)*100;
            const dp_dx=(pressureGrid[iy*gW+ix1]-pressureGrid[iy*gW+ix0])/((ix1-ix0)*dx)*100;
            windU[iy*gW+ix]=-inv_rf*dp_dy;
            windV[iy*gW+ix]= inv_rf*dp_dx;
            const spd=Math.sqrt(windU[iy*gW+ix]**2+windV[iy*gW+ix]**2);
            if (spd>maxSpd) maxSpd=spd;
        }
    }
    const norm=maxSpd>0?1/maxSpd:1;
    for (let i=0; i<gH*gW; i++) windSpd[i]=Math.sqrt(windU[i]**2+windV[i]**2)*norm;
}

// ── Frame loading & interpolation ──────────────────────────────────────────────
function buildWindFrame(d) {
    const nLat=d.u_wind.length, nLon=d.u_wind[0].length;
    const u=new Float32Array(nLat*nLon), v=new Float32Array(nLat*nLon);
    for (let iy=0; iy<nLat; iy++)
        for (let ix=0; ix<nLon; ix++) {
            u[iy*nLon+ix]=d.u_wind[iy][ix];
            v[iy*nLon+ix]=d.v_wind[iy][ix];
        }
    // 4-pass 3×3 box blur — smooths C1 discontinuities at grid edges
    const uBuf=new Float32Array(nLat*nLon), vBuf=new Float32Array(nLat*nLon);
    for (let p=0; p<4; p++) {
        for (let iy=0; iy<nLat; iy++) {
            for (let ix=0; ix<nLon; ix++) {
                let su=0, sv=0, n=0;
                for (let dy=-1; dy<=1; dy++) {
                    for (let dx=-1; dx<=1; dx++) {
                        const ny=Math.max(0,Math.min(nLat-1,iy+dy));
                        const nx=(ix+dx+nLon)%nLon;
                        su+=u[ny*nLon+nx]; sv+=v[ny*nLon+nx]; n++;
                    }
                }
                uBuf[iy*nLon+ix]=su/n; vBuf[iy*nLon+ix]=sv/n;
            }
        }
        u.set(uBuf); v.set(vBuf);
    }
    const pressure=d.pressure ? new Float32Array(d.pressure.flat()) : null;
    return { u, v, time: d.time, nLat, nLon, pressure };
}

async function loadAllFrames() {
    const statusEl = document.getElementById('status');
    for (let i = 0; i < 16; i++) {
        statusEl.textContent = `Loading Sandy… ${i + 1} / 16`;
        const r = await fetch(`./data/frames/frame_${String(i).padStart(3, '0')}.json`);
        if (!r.ok) throw new Error(`frame_${i} not found`);
        allFrames.push(buildWindFrame(await r.json()));
    }
    globalMaxSpd = 0;
    for (const f of allFrames)
        for (let i = 0; i < f.u.length; i++) {
            const spd = Math.sqrt(f.u[i] ** 2 + f.v[i] ** 2);
            if (spd > globalMaxSpd) globalMaxSpd = spd;
        }
    if (!globalMaxSpd) globalMaxSpd = 1;
    windH = allFrames[0].nLat;
    windW = allFrames[0].nLon;
    windU    = new Float32Array(windH * windW);
    windV    = new Float32Array(windH * windW);
    windSpd  = new Float32Array(windH * windW);
    interpolateWindField();
    computeVorticityGrid();
    hasPressure = allFrames.every(f => f.pressure !== null);
    if (hasPressure) {
        pressureGrid = new Float32Array(windH * windW);
        interpolatePressure();
        computeGeostrophicWind();
        presFrameMin = Math.min(...pressureGrid);
        presFrameMax = Math.max(...pressureGrid);
    }
}

function interpolateWindField() {
    const f0 = allFrames[frameIdx];
    const f1 = allFrames[(frameIdx + 1) % allFrames.length];
    const t = frameFrac, t1 = 1 - t, mx = globalMaxSpd;
    for (let i = 0; i < windH * windW; i++) {
        windU[i]   = f0.u[i] * t1 + f1.u[i] * t;
        windV[i]   = f0.v[i] * t1 + f1.v[i] * t;
        windSpd[i] = Math.sqrt(windU[i] ** 2 + windV[i] ** 2) / mx;
    }
}

function interpolatePressure() {
    if (!hasPressure) return;
    const f0 = allFrames[frameIdx].pressure;
    const f1 = allFrames[(frameIdx + 1) % allFrames.length].pressure;
    const t = frameFrac, t1 = 1 - t;
    for (let i = 0; i < windH * windW; i++) pressureGrid[i] = f0[i] * t1 + f1[i] * t;
}

// ── Particle state ─────────────────────────────────────────────────────────────
const ax       = new Float32Array(MAX_PART);
const ay       = new Float32Array(MAX_PART);
const aLife    = new Float32Array(MAX_PART);
const aMaxLife = new Float32Array(MAX_PART);

// Ring-buffer trail history: position + IR depth at each recorded step
const posHistX  = new Float32Array(MAX_PART * TRAIL_MAX);
const posHistY  = new Float32Array(MAX_PART * TRAIL_MAX);
const depthHist = new Float32Array(MAX_PART * TRAIL_MAX);
const aHistHead = new Uint8Array(MAX_PART);
const aHistCnt  = new Uint8Array(MAX_PART);

// Per-instance GPU attributes (rebuilt each frame)
const instDepth = new Float32Array(MAX_INST);
const instAlpha = new Float32Array(MAX_INST);

let partMesh;
const dummy = new THREE.Object3D();

// ── Background IR fill ─────────────────────────────────────────────────────────
// Canvas radial gradient centred on Sandy's NHC track position, updated every tick.
// Colour stops mirror the VIIRS IR palette: white eye → red eyewall → yellow → green → cyan.
const BG_W = 640, BG_H = 192;
let _bgCanvas = null, _bgTex = null, _bgMat = null;

function initStormBackground() {
    _bgCanvas        = document.createElement('canvas');
    _bgCanvas.width  = BG_W;
    _bgCanvas.height = BG_H;
    _bgTex = new THREE.CanvasTexture(_bgCanvas);
    _bgTex.magFilter = THREE.LinearFilter;
    _bgTex.minFilter = THREE.LinearFilter;
    _bgMat = new THREE.MeshBasicMaterial({
        map:         _bgTex,
        transparent: true,
        blending:    THREE.NormalBlending,
        depthWrite:  false,
        opacity:     params.fieldOpacity,
    });
    const bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(RENDER_W, RENDER_H), _bgMat);
    bgMesh.position.z = -0.5;
    scene.add(bgMesh);
    updateStormBackground();
}

function updateStormBackground() {
    if (!_bgCanvas) return;
    const ctx = _bgCanvas.getContext('2d');
    ctx.clearRect(0, 0, BG_W, BG_H);

    // Map storm world-space position to canvas pixels
    const c  = currentStormWorld();
    const cx = (c.x + HALF_W) / RENDER_W * BG_W;
    const cy = (HALF_H - c.y) / RENDER_H * BG_H;   // Y is inverted in canvas
    const r  = BG_W * 0.40;

    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0.00, 'rgba(245,240,228,0.88)');   // eye — warm cream
    g.addColorStop(0.06, 'rgba(210,165,38,0.84)');    // amber
    g.addColorStop(0.14, 'rgba(205,58,14,0.82)');     // eyewall — brick red
    g.addColorStop(0.24, 'rgba(165,22,8,0.78)');      // dark red
    g.addColorStop(0.36, 'rgba(178,82,12,0.72)');     // burnt orange
    g.addColorStop(0.48, 'rgba(175,155,18,0.64)');    // warm amber (not pure yellow)
    g.addColorStop(0.60, 'rgba(70,138,52,0.54)');     // sage green
    g.addColorStop(0.72, 'rgba(28,110,98,0.40)');     // teal
    g.addColorStop(0.86, 'rgba(22,72,130,0.20)');     // steel blue
    g.addColorStop(1.00, 'rgba(4,8,24,0.00)');        // fade to void
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, BG_W, BG_H);
    _bgTex.needsUpdate = true;
}

// ── Eye glow overlay ───────────────────────────────────────────────────────────
// Canvas sprite centred on Sandy's NHC track position.
// Concentric radial gradients mimic the VIIRS IR eye structure:
// warm white eye → red-orange eyewall → yellow → green outer bands.
let eyeSprite = null, eyeCanvas = null, eyeTex = null;
let eyeAngle  = 0;

function initEye() {
    eyeCanvas = document.createElement('canvas');
    eyeCanvas.width = eyeCanvas.height = 512;
    eyeTex = new THREE.CanvasTexture(eyeCanvas);
    eyeSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map:         eyeTex,
        transparent: true,
        blending:    THREE.NormalBlending,
        depthWrite:  false,
    }));
    eyeSprite.position.z = 0.3;
    scene.add(eyeSprite);
    updateEye();
}

function updateEye() {
    if (!eyeCanvas) return;
    const S = 512, CX = 256, CY = 256;
    const ctx = eyeCanvas.getContext('2d');
    ctx.clearRect(0, 0, S, S);

    // Storm intensity 0→1 derived from frame's minimum pressure
    let intensity = 0;
    if (hasPressure && presFrameMin < 1013) {
        const globalRange = 1013 - 920;
        intensity = Math.min(1, (1013 - presFrameMin) / globalRange) * params.eyeGlow;
    } else {
        intensity = 0.4 * params.eyeGlow;
    }

    if (intensity < 0.02) { eyeTex.needsUpdate = true; return; }

    // ── Eyewall (muted brick-red ring) — background handles outer bands ───
    let g = ctx.createRadialGradient(CX, CY, S*0.06, CX, CY, S*0.20);
    g.addColorStop(0,    `rgba(210,155,22,${(intensity*0.88).toFixed(2)})`);
    g.addColorStop(0.35, `rgba(205,55,12,${(intensity*0.94).toFixed(2)})`);
    g.addColorStop(1,    'rgba(90,8,4,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);

    // ── Eye clearing (warm cream spot) ───────────────────────────────────
    g = ctx.createRadialGradient(CX, CY, 0, CX, CY, S*0.09);
    g.addColorStop(0,   `rgba(245,238,220,${(intensity*0.94).toFixed(2)})`);
    g.addColorStop(0.5, `rgba(220,190,110,${(intensity*0.76).toFixed(2)})`);
    g.addColorStop(1,   'rgba(180,90,10,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);

    eyeTex.needsUpdate = true;
    eyeAngle += 0.002;

    // Position and scale — tighter sprite since outer fill is now the background
    const center    = currentStormWorld();
    const worldSize = RENDER_W * 0.22 * Math.max(0.4, intensity);
    eyeSprite.position.set(center.x, center.y, 0.3);
    eyeSprite.scale.set(worldSize, worldSize, 1);
}

// ── Particle mesh ──────────────────────────────────────────────────────────────
function initMesh() {
    const geo = new THREE.BufferGeometry();
    // Unit square quad (trail dots are square; bloom softens them to circles)
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -0.5,-0.5,0,  0.5,-0.5,0,  0.5,0.5,0,
        -0.5,-0.5,0,  0.5, 0.5,0, -0.5,0.5,0,
    ]), 3));

    const mat = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        blending:    THREE.NormalBlending,
        depthWrite:  false,
        depthTest:   false,
    });

    partMesh = new THREE.InstancedMesh(geo, mat, MAX_INST);
    partMesh.frustumCulled = false;
    partMesh.count = 0;
    partMesh.geometry.setAttribute('iDepth', new THREE.InstancedBufferAttribute(instDepth, 1));
    partMesh.geometry.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(instAlpha, 1));
    scene.add(partMesh);
}

// ── Spawn ──────────────────────────────────────────────────────────────────────
function spawn(i, stagger = false) {
    const center = currentStormWorld();
    let px, py;
    if (Math.random() < 0.92) {
        // Spawn directly on a spiral arm — 92% of particles.
        // This creates genuinely dark gaps between arms; the force then keeps them there.
        // Logarithmic spiral: θ_k(r) = armPitch × ln(r/r₀) + k×(2π/N) + armPhase
        const N    = Math.round(params.numArms);
        const arm  = Math.floor(Math.random() * N);
        const r0   = RENDER_W * 0.03;    // inner radius (~eye edge)
        const rMax = RENDER_W * 0.34;    // outer band limit — extends far enough to fill frame
        // Bias toward inner bands where density matches a real storm eye-wall
        const r    = r0 + Math.pow(Math.random(), 0.55) * (rMax - r0);
        const armθ = params.armPitch * Math.log(r / r0)
                     + arm * (Math.PI * 2 / N)
                     + armPhase;
        // Very tight scatter (±6% of rMax) — keeps gaps dark
        const scatter = (Math.random() - 0.5) * rMax * 0.06;
        const perpθ   = armθ + Math.PI / 2;
        px = center.x + Math.cos(armθ) * r + Math.cos(perpθ) * scatter;
        py = center.y + Math.sin(armθ) * r + Math.sin(perpθ) * scatter;
    } else {
        // 8% ambient particles scattered lightly around the storm for background haze
        const angle = Math.random() * Math.PI * 2;
        const r     = Math.sqrt(Math.random()) * RENDER_W * 0.36;
        px = center.x + Math.cos(angle) * r;
        py = center.y + Math.sin(angle) * r;
    }
    ax[i] = Math.max(-HALF_W, Math.min(HALF_W, px));
    ay[i] = Math.max(-HALF_H, Math.min(HALF_H, py));
    aMaxLife[i]  = params.lifeMin + Math.random() * (params.lifeMax - params.lifeMin);
    aLife[i]     = stagger ? Math.random() * aMaxLife[i] : 0;
    aHistHead[i] = 0;
    aHistCnt[i]  = 0;
}

// ── Update loop ────────────────────────────────────────────────────────────────
const statusEl = document.getElementById('status');

function update() {
    // Advance frame animation
    if (allFrames.length > 1) {
        frameFrac += 1 / params.frameDuration;
        if (frameFrac >= 1) {
            frameFrac -= 1;
            frameIdx = (frameIdx + 1) % allFrames.length;
            statusEl.textContent = allFrames[frameIdx].time;
        }
        interpolateWindField();
        computeVorticityGrid();
        if (hasPressure) {
            interpolatePressure();
            computeGeostrophicWind();
            presFrameMin = Infinity; presFrameMax = -Infinity;
            for (let k = 0; k < windH * windW; k++) {
                if (pressureGrid[k] < presFrameMin) presFrameMin = pressureGrid[k];
                if (pressureGrid[k] > presFrameMax) presFrameMax = pressureGrid[k];
            }
        }
    }

    const N    = Math.min(params.partCount, MAX_PART);
    const tLen = Math.round(params.trailSteps);
    const dot  = params.dotSize;
    let ti = 0;

    // Arm phase advances once per frame — keeps arms from appearing completely static
    armPhase += 0.0005;   // full rotation ≈ 12 600 ticks ≈ 70 min @ 30 fps

    // Storm centre for synthetic vortex and arm calculations
    const center    = currentStormWorld();
    const eyeRadius = RENDER_W * 0.14;

    for (let i = 0; i < MAX_PART; i++) {
        if (i >= N) continue;

        aLife[i]++;
        if (aLife[i] >= aMaxLife[i]) spawn(i);

        const w = bilinear(ax[i], ay[i]);

        // Geostrophic / ERA5 wind
        let uu = w.u, vv = w.v;

        // Synthetic vortex centred on Sandy's NHC position.
        // Adds tight CCW (NH cyclonic) rotation near the eye so spiral bands emerge
        // even at ERA5's coarse 10° resolution.
        const dx   = ax[i] - center.x;
        const dy   = ay[i] - center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < eyeRadius * 2.5 && dist > 1) {
            const blend = Math.max(0, 1 - dist / (eyeRadius * 2.5));
            const vStr  = blend * blend * params.eyeSwirl;
            uu += (-dy / dist) * vStr;   // perpendicular CCW
            vv += ( dx / dist) * vStr;
        }

        // Spiral arm attraction — draws particles toward N logarithmic spiral arms.
        // Each arm follows θ_k(r) = armPitch × ln(r/r₀) + k×(2π/N) + armPhase.
        // The tangential force toward the nearest arm creates distinct bands with
        // gaps between them, replacing the featureless whirlpool with a starfish shape.
        if (params.armStrength > 0 && dist > 10 && dist < eyeRadius * 4) {
            const θ      = Math.atan2(dy, dx);
            const r0     = RENDER_W * 0.03;
            const rSafe  = Math.max(r0 * 0.3, dist);
            const armAng = params.armPitch * Math.log(rSafe / r0);
            const N      = Math.round(params.numArms);

            // Find signed angular distance to the nearest arm (−π … +π)
            let minDelta = Infinity;
            for (let k = 0; k < N; k++) {
                const armθ = armAng + k * (Math.PI * 2 / N) + armPhase;
                let delta  = ((θ - armθ) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
                if (delta > Math.PI) delta -= Math.PI * 2;
                if (Math.abs(delta) < Math.abs(minDelta)) minDelta = delta;
            }

            // tanh gives smooth full-strength pull far from arm, linear near centre
            const outerFade = Math.max(0, 1 - dist / (eyeRadius * 4));
            const fArm      = Math.tanh(minDelta * 3) * params.armStrength * outerFade;
            // (dy/dist, −dx/dist) is the clockwise tangential direction;
            // positive fArm (particle CCW of arm) applies a CW nudge back toward it
            uu +=  (dy / dist) * fArm;
            vv += -(dx / dist) * fArm;
        }

        ax[i] += uu * params.flowSpeed;
        ay[i] += vv * params.flowSpeed;

        // Horizontal wrap; respawn at top/bottom
        if (ax[i] >  HALF_W) ax[i] -= RENDER_W;
        if (ax[i] < -HALF_W) ax[i] += RENDER_W;
        if (Math.abs(ay[i]) > HALF_H * 0.97) spawn(i);

        // Record trail: position + IR depth (radial distance from storm centre)
        const depth = sampleDepth(dist);
        posHistX [i * TRAIL_MAX + aHistHead[i]] = ax[i];
        posHistY [i * TRAIL_MAX + aHistHead[i]] = ay[i];
        depthHist[i * TRAIL_MAX + aHistHead[i]] = depth;
        aHistHead[i] = (aHistHead[i] + 1) % TRAIL_MAX;
        if (aHistCnt[i] < TRAIL_MAX) aHistCnt[i]++;

        // Life alpha with fade-in / fade-out
        const t    = aLife[i] / aMaxLife[i];
        const frac = 30 / aMaxLife[i];
        const lifeAlpha = t < frac ? t / frac : t > 1 - frac ? (1 - t) / frac : 1.0;

        // Emit all visible trail steps as instances
        const steps = Math.min(tLen, aHistCnt[i]);
        for (let j = 0; j < steps; j++) {
            if (ti >= MAX_INST) break;
            const hi       = ((aHistHead[i] - 1 - j) % TRAIL_MAX + TRAIL_MAX) % TRAIL_MAX;
            const ageFrac  = (j + 1) / (tLen + 1);          // 0 = newest, 1 = oldest
            const fade     = (1 - ageFrac) * (1 - ageFrac); // quadratic — fast drop-off

            instDepth[ti] = depthHist[i * TRAIL_MAX + hi];
            instAlpha[ti] = lifeAlpha * fade * 0.72;

            dummy.position.set(posHistX[i * TRAIL_MAX + hi], posHistY[i * TRAIL_MAX + hi], 0);
            dummy.rotation.z = 0;
            dummy.scale.setScalar(dot * (0.65 + 0.35 * (1 - ageFrac)));
            dummy.updateMatrix();
            partMesh.setMatrixAt(ti, dummy.matrix);
            ti++;
        }
    }

    partMesh.count = ti;
    partMesh.instanceMatrix.needsUpdate             = true;
    partMesh.geometry.attributes.iDepth.needsUpdate = true;
    partMesh.geometry.attributes.iAlpha.needsUpdate = true;

    // Background and eye update every tick — storm centre interpolates continuously
    updateStormBackground();
    updateEye();
}

// ── Sidebar controls ───────────────────────────────────────────────────────────
function setupControls() {
    function bind(id, valId, fmt, onChange) {
        const el    = document.getElementById(id);
        const valEl = document.getElementById(valId);
        if (!el) return;
        el.addEventListener('input', () => {
            const v = parseFloat(el.value);
            valEl.textContent = fmt(v);
            onChange(v);
        });
    }

    bind('frame-duration',  'frame-duration-val',  v => Math.round(v),  v => { params.frameDuration  = v; });
    bind('part-count',      'part-count-val',      v => Math.round(v),  v => { params.partCount      = v; });
    bind('flow-speed',      'flow-speed-val',      v => v.toFixed(2),   v => { params.flowSpeed      = v; });
    bind('dot-size',        'dot-size-val',        v => v.toFixed(1),   v => { params.dotSize        = v; });
    bind('trail-steps',     'trail-steps-val',     v => Math.round(v),  v => { params.trailSteps     = v; });
    bind('eye-swirl',       'eye-swirl-val',       v => Math.round(v),  v => { params.eyeSwirl       = v; });
    bind('num-arms',        'num-arms-val',        v => Math.round(v),  v => { params.numArms        = v; });
    bind('arm-pitch',       'arm-pitch-val',       v => v.toFixed(1),   v => { params.armPitch       = v; });
    bind('arm-strength',    'arm-strength-val',    v => Math.round(v),  v => { params.armStrength    = v; });
    bind('intensity-boost', 'intensity-boost-val', v => v.toFixed(1),   v => { params.intensityBoost = v; });
    bind('field-opacity',   'field-opacity-val',   v => v.toFixed(2),   v => {
        params.fieldOpacity = v;
        if (_bgMat) _bgMat.opacity = v;
    });
    bind('eye-glow',        'eye-glow-val',        v => v.toFixed(2),   v => { params.eyeGlow        = v; });
    bind('life-min',        'life-min-val',        v => Math.round(v),  v => { params.lifeMin        = v; });
    bind('life-max',        'life-max-val',        v => Math.round(v),  v => { params.lifeMax        = v; });
    bind('bloom-strength',  'bloom-strength-val',  v => v.toFixed(1),   v => { bloomPass.strength    = v; });
    bind('bloom-radius',    'bloom-radius-val',    v => v.toFixed(2),   v => { bloomPass.radius      = v; });
    bind('bloom-thresh',    'bloom-thresh-val',    v => v.toFixed(2),   v => { bloomPass.threshold   = v; });

    const blendEl = document.getElementById('blend-mode');
    if (blendEl) {
        blendEl.addEventListener('change', () => {
            const mode = parseInt(blendEl.value);
            if (partMesh)  { partMesh.material.blending  = mode; partMesh.material.needsUpdate  = true; }
            if (_bgMat)    { _bgMat.blending             = mode; _bgMat.needsUpdate             = true; }
            if (eyeSprite) { eyeSprite.material.blending = mode; eyeSprite.material.needsUpdate = true; }
        });
    }
}

// ── Keyboard ───────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
    if (e.code === 'KeyS') {
        composer.render();
        const a = document.createElement('a');
        a.download = `sandy_ir_${Date.now()}.png`;
        a.href     = renderer.domElement.toDataURL('image/png');
        a.click();
    }
    if (e.code === 'KeyH') {
        document.getElementById('sidebar').classList.toggle('ui-hidden');
    }
});

// ── Render loop ────────────────────────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);
    update();
    composer.render();
}

// ── Synthetic wind fallback (when ERA5 frames not found) ──────────────────────
function makeSyntheticWind() {
    // Dominant cyclone placed at Sandy's Oct 28 position (31°N 73°W)
    const VORTICES = [
        { lat: 31, lon: -73, str: 22, r: 12, spin:  1 },  // Sandy analog
        { lat: 45, lon: -30, str:  9, r: 14, spin:  1 },  // North Atlantic high-lat low
        { lat: 25, lon: -90, str:  7, r: 10, spin: -1 },  // subtropical high ridge
    ];
    const W = 72, H = 36;
    const u = new Float32Array(W * H), v = new Float32Array(W * H), s = new Float32Array(W * H);
    for (let iy = 0; iy < H; iy++) {
        const lat = -87.5 + iy * 5;
        for (let ix = 0; ix < W; ix++) {
            const lon = -177.5 + ix * 5;
            let uv = 0, vv = 0;
            for (const vc of VORTICES) {
                let dlat = lat - vc.lat, dlon = lon - vc.lon;
                if (dlon >  180) dlon -= 360;
                if (dlon < -180) dlon += 360;
                const dist = Math.sqrt(dlat * dlat + dlon * dlon);
                if (dist < vc.r * 3.5 && dist > 0.5) {
                    const f = vc.str * Math.exp(-((dist / vc.r) ** 2));
                    uv += f * (-vc.spin * dlon / (dist + 1));
                    vv += f * ( vc.spin * dlat / (dist + 1));
                }
            }
            u[iy*W+ix] = uv; v[iy*W+ix] = vv;
            s[iy*W+ix] = Math.sqrt(uv**2 + vv**2);
        }
    }
    const mx = Math.max(...s) || 1;
    for (let i = 0; i < s.length; i++) s[i] /= mx;
    windW = W; windH = H; windU = u; windV = v; windSpd = s;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
(async () => {
    try {
        await loadAllFrames();
        statusEl.textContent = allFrames[0].time;
    } catch (_) {
        makeSyntheticWind();
        computeVorticityGrid();
        statusEl.textContent = 'synthetic wind (no ERA5 frames)';
    }

    initMesh();
    initStormBackground();
    initEye();
    setupControls();
    for (let i = 0; i < params.partCount; i++) spawn(i, true);
    animate();
})();
