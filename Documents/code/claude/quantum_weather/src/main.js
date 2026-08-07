/**
 * main.js — Quantum Weather: Moving Arrow Swarm
 *
 * Canvas: 2560 × 768  (2× LED native 1280×384)
 */

import * as THREE from 'three';
import { EffectComposer }  from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }      from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

// ── Canvas ─────────────────────────────────────────────────────────────────────
const RENDER_W = 2560, RENDER_H = 768;
const HALF_W = RENDER_W / 2, HALF_H = RENDER_H / 2;

// ── Geographic view window ──────────────────────────────────────────────────────
// Crop to the North Atlantic so the LED format focuses on Sandy's story.
// All coordinate conversions (bilinear, map, marker, grid) derive from this.
// Latitude span chosen so lon°×cos(midLat) / lat° ≈ RENDER_W/RENDER_H,
// keeping equirectangular stretch to ~1.6% at 40°N.
const VIEW = { lonMin: -120, lonMax: 20, latMin: 8, latMax: 50 };

// ── Max pool size ──────────────────────────────────────────────────────────────
const MAX_ARROWS = 10000;

// ── Live params ────────────────────────────────────────────────────────────────
const params = {
    arrowCount:    1400,
    flowSpeed:     0.1,
    scale:         40,
    alphaMin:      0.35,
    lifeMin:       120,
    lifeMax:       360,
    fadeFrames:    30,
    hueOffset:     0.55,
    hueRange:      0.15,  // narrow arc: blue-cyan only — use speed/convergence modes for full palette
    saturation:    0.85,
    lightness:     0.5,
    brightFloor:   0.25,
    colourSmooth:  0.04,
    frameDuration: 240,   // animation ticks per Sandy data frame (240 @ ~30fps ≈ 8s)
    mapOpacity:    0.9,   // 0 = map invisible, 1 = fully opaque
    windOpacity:   1.0,   // wind field glow intensity
    speedColour:     0,     // 0 = direction hue, 1 = speed hue
    divColour:       0,     // 0 = off, 1 = full convergence colouring
    vortColour:      0,     // 0 = off, 1 = full vorticity colouring
    intensityBoost:  1,     // multiplier on pressure/vorticity — pushes palette toward red
    trailLength:     0,     // 0 = off, 1–120 visible history steps
};

// ── Sandy NHC best-track positions (6-hourly, Oct 26 00Z → Oct 29 18Z) ─────────
// One entry per frame, matching frame_000 through frame_015.
const SANDY_TRACK = [
    { lat: 15.8, lon: -75.4 },  // 000  Oct 26 00Z  TS forming near Jamaica
    { lat: 16.5, lon: -76.7 },  // 001  Oct 26 06Z
    { lat: 17.3, lon: -77.8 },  // 002  Oct 26 12Z
    { lat: 18.8, lon: -78.3 },  // 003  Oct 26 18Z  Cat 1
    { lat: 20.9, lon: -77.9 },  // 004  Oct 27 00Z  crossing Cuba
    { lat: 22.9, lon: -77.2 },  // 005  Oct 27 06Z
    { lat: 24.6, lon: -76.1 },  // 006  Oct 27 12Z
    { lat: 26.4, lon: -75.2 },  // 007  Oct 27 18Z
    { lat: 28.1, lon: -74.5 },  // 008  Oct 28 00Z  heading north
    { lat: 29.9, lon: -73.8 },  // 009  Oct 28 06Z
    { lat: 31.8, lon: -73.4 },  // 010  Oct 28 12Z
    { lat: 34.3, lon: -73.9 },  // 011  Oct 28 18Z  extratropical transition
    { lat: 36.5, lon: -74.0 },  // 012  Oct 29 00Z
    { lat: 38.0, lon: -74.0 },  // 013  Oct 29 06Z
    { lat: 39.4, lon: -74.0 },  // 014  Oct 29 12Z
    { lat: 40.6, lon: -74.0 },  // 015  Oct 29 18Z  landfall NJ ~23:30Z
];

// Convert geographic lat/lon to Three.js world coordinates using the same
// equirectangular formula as the map background so the marker aligns with
// visible coastlines.  lon -180→+180 maps to x -HALF_W→+HALF_W,
// lat +90→-90 maps to y +HALF_H→-HALF_H.
function trackToWorld(lat, lon) {
    const x = (lon - VIEW.lonMin) / (VIEW.lonMax - VIEW.lonMin) * RENDER_W - HALF_W;
    const y = (lat - VIEW.latMin) / (VIEW.latMax - VIEW.latMin) * RENDER_H - HALF_H;
    return { x, y };
}

// ── Frame animation state ──────────────────────────────────────────────────────
const allFrames   = [];   // [{u, v, time}, …] — pre-smoothed ERA5 frames
let   globalMaxSpd = 1;   // max speed across all frames (keeps brightness consistent)
let   frameIdx    = 0;    // current data frame index
let   frameFrac   = 0;    // 0..1 progress toward next frame

// ── Unit arrow shape ───────────────────────────────────────────────────────────
const UNIT_VERTS = new Float32Array([
    -0.50,  0.028, 0,    0.20,  0.028, 0,    0.20, -0.028, 0,
    -0.50,  0.028, 0,    0.20, -0.028, 0,   -0.50, -0.028, 0,
     0.20,  0.13,  0,    0.50,  0.00,  0,    0.20, -0.13,  0,
]);

const UNIT_FADE = new Float32Array([
    0.20, 0.95, 0.95,   0.20, 0.95, 0.20,   0.80, 1.00, 0.80,
]);

// ── Renderer ───────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(RENDER_W, RENDER_H);
renderer.setClearColor(0x000000);
document.getElementById('canvas-frame').appendChild(renderer.domElement);

const camera = new THREE.OrthographicCamera(-HALF_W, HALF_W, HALF_H, -HALF_H, -1, 1);
const scene   = new THREE.Scene();

const composer  = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(RENDER_W, RENDER_H), 0.0, 0.15, 0.4);
composer.addPass(bloomPass);

// ── Shaders ────────────────────────────────────────────────────────────────────
const vertexShader = /* glsl */ `
    attribute float fade;
    attribute float iAlpha;
    attribute float iSpeed;
    attribute float iDir;
    attribute float iDiv;
    attribute float iVort;

    uniform float uHueOffset;
    uniform float uHueRange;
    uniform float uSaturation;
    uniform float uLightness;
    uniform float uBrightFloor;
    uniform float uSpeedColour;
    uniform float uDivColour;
    uniform float uVortColour;

    varying vec3  vColor;
    varying float vAlpha;

    vec3 hsl2rgb(float h, float s, float l) {
        float c = (1.0 - abs(2.0 * l - 1.0)) * s;
        float x = c * (1.0 - abs(mod(h * 6.0, 2.0) - 1.0));
        float m = l - c * 0.5;
        vec3 rgb;
        float h6 = h * 6.0;
        if      (h6 < 1.0) rgb = vec3(c, x, 0.0);
        else if (h6 < 2.0) rgb = vec3(x, c, 0.0);
        else if (h6 < 3.0) rgb = vec3(0.0, c, x);
        else if (h6 < 4.0) rgb = vec3(0.0, x, c);
        else if (h6 < 5.0) rgb = vec3(x, 0.0, c);
        else               rgb = vec3(c, 0.0, x);
        return rgb + m;
    }

    // Infrared satellite palette: blue → cyan → green → yellow → orange → red
    // Matches the reference radar imagery — outer/weak = blue, inner/intense = red.
    float radarHue(float t) {
        t = clamp(t, 0.0, 1.0);
        if (t < 0.25) return mix(0.67, 0.50, t * 4.0);
        if (t < 0.50) return mix(0.50, 0.33, (t - 0.25) * 4.0);
        if (t < 0.75) return mix(0.33, 0.10, (t - 0.50) * 4.0);
                      return mix(0.10, 0.00, (t - 0.75) * 4.0);
    }

    void main() {
        // Direction mode: narrow blue-cyan arc — ambient, not rainbow
        float dirHue   = mod(uHueOffset + iDir * uHueRange, 1.0);
        float speedHue = radarHue(iSpeed);
        float baseHue  = mix(dirHue, speedHue, uSpeedColour);
        float hue      = mix(baseHue, radarHue(iDiv),  uDivColour);
        hue            = mix(hue,     radarHue(iVort), uVortColour);
        vec3 baseColor = hsl2rgb(hue, uSaturation, uLightness);
        float brightness = fade * iAlpha * (uBrightFloor + (1.0 - uBrightFloor) * iSpeed);
        vColor = baseColor;
        vAlpha = brightness;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    }
`;

const fragmentShader = /* glsl */ `
    varying vec3  vColor;
    varying float vAlpha;
    void main() { gl_FragColor = vec4(vColor, vAlpha); }
`;

// ── Wind data ──────────────────────────────────────────────────────────────────
let windU, windV, windSpd, windW = 36, windH = 18;
let divGrid  = null;   // normalised convergence 0..1 per grid cell
let vortGrid = null;   // normalised cyclonic vorticity 0..1 per grid cell

// ── Pressure data ──────────────────────────────────────────────────────────────
let pressureGrid  = null;   // Float32Array, current interpolated MSLP (hPa)
let hasPressure   = false;
let presFrameMin  = 920;    // updated each frame — lowest pressure seen (storm center)
let presFrameMax  = 1030;   // updated each frame — highest pressure seen (ambient)

function bilinear(px, py) {
    // Canvas position → geographic coordinates within the VIEW window
    const lon = VIEW.lonMin + (px + HALF_W) / RENDER_W * (VIEW.lonMax - VIEW.lonMin);
    const lat = VIEW.latMin + (py + HALF_H) / RENDER_H * (VIEW.latMax - VIEW.latMin);
    // Geographic coordinates → ERA5 grid indices
    const lonStep = 350 / (windW - 1);   // 10° for 36-col Sandy grid
    const latStep = 170 / (windH - 1);   // 10° for 18-row Sandy grid
    const gx = (lon + 175) / lonStep;
    const gy = (lat + 85)  / latStep;
    const x0 = Math.max(0, Math.min(windW - 1, Math.floor(gx)));
    const y0 = Math.max(0, Math.min(windH - 1, Math.floor(gy)));
    const x1 = Math.min(windW - 1, x0 + 1);
    const y1 = Math.min(windH - 1, y0 + 1);
    const fx = gx - x0, fy = gy - y0;
    const i00=y0*windW+x0, i10=y0*windW+x1, i01=y1*windW+x0, i11=y1*windW+x1;
    const bl = a => (a[i00]*(1-fx)+a[i10]*fx)*(1-fy)+(a[i01]*(1-fx)+a[i11]*fx)*fy;
    return { u: bl(windU), v: bl(windV), spd: bl(windSpd),
             div:  divGrid      ? bl(divGrid)      : 0,
             vort: vortGrid     ? bl(vortGrid)     : 0,
             pres: pressureGrid ? bl(pressureGrid) : 0 };
}

// Compute ∂u/∂x + ∂v/∂y at each grid cell from the current windU/windV (ERA5, before
// any geostrophic override).  Negative divergence = convergence = storm development signal.
// Output stored in divGrid normalised to 0..1 where 1 = strongest convergence.
function computeDivergenceGrid() {
    if (!windU || !windV) return;
    if (!divGrid) divGrid = new Float32Array(windH * windW);

    const gW = windW, gH = windH;
    const lonStep = 350 / (gW - 1);
    const latStep = 170 / (gH - 1);
    const R = 6.371e6;
    const dyM = latStep * Math.PI / 180 * R;   // metres per grid row (constant)

    let maxAbsDiv = 1e-10;

    for (let iy = 0; iy < gH; iy++) {
        const lat    = -85 + iy * latStep;
        const cosLat = Math.max(0.01, Math.cos(lat * Math.PI / 180));
        const dxM   = cosLat * lonStep * Math.PI / 180 * R;   // metres per col at this lat

        for (let ix = 0; ix < gW; ix++) {
            const ix0 = Math.max(0, ix - 1), ix1 = Math.min(gW - 1, ix + 1);
            const iy0 = Math.max(0, iy - 1), iy1 = Math.min(gH - 1, iy + 1);

            const du_dx = (windU[iy  * gW + ix1] - windU[iy  * gW + ix0]) / ((ix1 - ix0) * dxM);
            const dv_dy = (windV[iy1 * gW + ix ] - windV[iy0 * gW + ix ]) / ((iy1 - iy0) * dyM);

            divGrid[iy * gW + ix] = du_dx + dv_dy;
            const abs = Math.abs(du_dx + dv_dy);
            if (abs > maxAbsDiv) maxAbsDiv = abs;
        }
    }

    // Normalise: convergence (negative raw div) → 1.0; diverging/neutral → 0.0.
    // sqrt boost makes moderate convergence visible — raw synoptic divergence is very small
    // (~10⁻⁵ s⁻¹) so a linear map keeps most of the field near 0.
    const norm = 1 / maxAbsDiv;
    for (let i = 0; i < gH * gW; i++) {
        divGrid[i] = Math.sqrt(Math.max(0, -divGrid[i] * norm));
    }
}

// Compute ∂v/∂x − ∂u/∂y at each grid cell (relative vorticity).
// Positive = cyclonic (counterclockwise in NH) = hurricane/low structure.
// Vorticity has a much stronger synoptic signal than divergence — the rotating
// hurricane spans several 10° cells, giving large dv/dx and du/dy terms.
function computeVorticityGrid() {
    if (!windU || !windV) return;
    if (!vortGrid) vortGrid = new Float32Array(windH * windW);

    const gW = windW, gH = windH;
    const lonStep = 350 / (gW - 1);
    const latStep = 170 / (gH - 1);
    const R   = 6.371e6;
    const dyM = latStep * Math.PI / 180 * R;

    let maxAbsVort = 1e-10;

    for (let iy = 0; iy < gH; iy++) {
        const lat    = -85 + iy * latStep;
        const cosLat = Math.max(0.01, Math.cos(lat * Math.PI / 180));
        const dxM   = cosLat * lonStep * Math.PI / 180 * R;

        for (let ix = 0; ix < gW; ix++) {
            const ix0 = Math.max(0, ix - 1), ix1 = Math.min(gW - 1, ix + 1);
            const iy0 = Math.max(0, iy - 1), iy1 = Math.min(gH - 1, iy + 1);

            const dv_dx = (windV[iy  * gW + ix1] - windV[iy  * gW + ix0]) / ((ix1 - ix0) * dxM);
            const du_dy = (windU[iy1 * gW + ix ] - windU[iy0 * gW + ix ]) / ((iy1 - iy0) * dyM);

            vortGrid[iy * gW + ix] = dv_dx - du_dy;
            const abs = Math.abs(dv_dx - du_dy);
            if (abs > maxAbsVort) maxAbsVort = abs;
        }
    }

    // Normalise: cyclonic (positive) → 1.0; anticyclonic/neutral → 0.0
    const norm = 1 / maxAbsVort;
    for (let i = 0; i < gH * gW; i++) {
        vortGrid[i] = Math.max(0, vortGrid[i] * norm);
    }
}

// ── Frame loading & interpolation ──────────────────────────────────────────────

// Parse and smooth a raw JSON frame into pre-processed {u, v, time} arrays.
// Smoothing (4 passes of 3x3 box blur) removes C1 discontinuities at grid edges.
function buildWindFrame(d) {
    const nLat = d.u_wind.length, nLon = d.u_wind[0].length;
    const u = new Float32Array(nLat * nLon);
    const v = new Float32Array(nLat * nLon);
    for (let iy = 0; iy < nLat; iy++)
        for (let ix = 0; ix < nLon; ix++) {
            u[iy * nLon + ix] = d.u_wind[iy][ix];
            v[iy * nLon + ix] = d.v_wind[iy][ix];
        }
    // 4-pass 3×3 box blur on U and V
    const uBuf = new Float32Array(nLat * nLon);
    const vBuf = new Float32Array(nLat * nLon);
    for (let p = 0; p < 4; p++) {
        for (let iy = 0; iy < nLat; iy++) {
            for (let ix = 0; ix < nLon; ix++) {
                let su = 0, sv = 0, n = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const ny = Math.max(0, Math.min(nLat - 1, iy + dy));
                        const nx = (ix + dx + nLon) % nLon;
                        su += u[ny * nLon + nx];
                        sv += v[ny * nLon + nx];
                        n++;
                    }
                }
                uBuf[iy * nLon + ix] = su / n;
                vBuf[iy * nLon + ix] = sv / n;
            }
        }
        u.set(uBuf); v.set(vBuf);
    }
    // Flatten pressure grid if present (row 0 = lat -85, row N = lat +85)
    const pressure = d.pressure
        ? new Float32Array(d.pressure.flat())
        : null;
    return { u, v, time: d.time, nLat, nLon, pressure };
}

// Load all 16 Sandy frames, find global speed max for consistent normalisation.
async function loadAllFrames() {
    const statusEl = document.getElementById('status');
    for (let i = 0; i < 16; i++) {
        statusEl.textContent = `Loading Sandy frames… ${i + 1} / 16`;
        const r = await fetch(`./data/frames/frame_${String(i).padStart(3, '0')}.json`);
        if (!r.ok) throw new Error(`frame_${i} not found`);
        allFrames.push(buildWindFrame(await r.json()));
    }
    // Global max speed across all frames keeps brightness stable as storm evolves
    globalMaxSpd = 0;
    for (const f of allFrames) {
        for (let i = 0; i < f.u.length; i++) {
            const spd = Math.sqrt(f.u[i] ** 2 + f.v[i] ** 2);
            if (spd > globalMaxSpd) globalMaxSpd = spd;
        }
    }
    if (globalMaxSpd === 0) globalMaxSpd = 1;
    // Set grid dimensions from first frame
    windH = allFrames[0].nLat;
    windW = allFrames[0].nLon;
    windU = new Float32Array(windH * windW);
    windV = new Float32Array(windH * windW);
    windSpd = new Float32Array(windH * windW);
    interpolateWindField();
    computeDivergenceGrid();   // from ERA5 before any geostrophic override
    computeVorticityGrid();

    // Pressure: available only after add_pressure.py has been run
    hasPressure = allFrames.every(f => f.pressure !== null);
    if (hasPressure) {
        pressureGrid = new Float32Array(windH * windW);
        interpolatePressure();
        computeGeostrophicWind();  // so spawn() uses geostrophic from the start
        presFrameMin = Math.min(...pressureGrid);
        presFrameMax = Math.max(...pressureGrid);
    }
}

// Lerp between the two surrounding frames and write windU / windV / windSpd.
// Called once per animation tick.
function interpolateWindField() {
    const f0 = allFrames[frameIdx];
    const f1 = allFrames[(frameIdx + 1) % allFrames.length];
    const t  = frameFrac, t1 = 1 - t;
    const mx = globalMaxSpd;
    for (let i = 0; i < windH * windW; i++) {
        windU[i] = f0.u[i] * t1 + f1.u[i] * t;
        windV[i] = f0.v[i] * t1 + f1.v[i] * t;
        windSpd[i] = Math.sqrt(windU[i] ** 2 + windV[i] ** 2) / mx;
    }
}

function interpolatePressure() {
    if (!hasPressure) return;
    const f0 = allFrames[frameIdx].pressure;
    const f1 = allFrames[(frameIdx + 1) % allFrames.length].pressure;
    const t = frameFrac, t1 = 1 - t;
    for (let i = 0; i < windH * windW; i++) {
        pressureGrid[i] = f0[i] * t1 + f1[i] * t;
    }
}

// Overwrite windU / windV / windSpd with geostrophic wind derived from pressureGrid.
// Geostrophic balance: u_g = -(1/ρf) ∂p/∂y,  v_g = +(1/ρf) ∂p/∂x
// This is mathematically guaranteed to flow CCW around NH lows (f>0)
// and CW around NH highs — the "classic" textbook pattern.
// The 10m ERA5 winds deviate from this due to surface friction; geostrophic
// winds at synoptic scale match what human intuition expects from isobars.
function computeGeostrophicWind() {
    if (!hasPressure || !pressureGrid) return;

    const gW = windW, gH = windH;
    const latStep = 170 / (gH - 1);          // degrees per row  (10°)
    const lonStep = 350 / (gW - 1);          // degrees per col  (10°)
    const R       = 6.371e6;                  // Earth radius (m)
    const OMEGA   = 7.2921e-5;               // Earth angular velocity (rad/s)
    const RHO     = 1.225;                   // sea-level air density (kg/m³)
    const dy      = latStep * Math.PI / 180 * R; // metres per grid row

    // Minimum |f| at 10° latitude — prevents blow-up near the equator
    const F_MIN = 2 * OMEGA * Math.sin(10 * Math.PI / 180);

    let maxSpd = 0;

    for (let iy = 0; iy < gH; iy++) {
        const lat    = -85 + iy * latStep;
        const latRad = lat * Math.PI / 180;
        const cosLat = Math.max(0.01, Math.cos(latRad));
        const dx     = cosLat * lonStep * Math.PI / 180 * R; // metres per grid col

        // Coriolis parameter f = 2Ω sin(φ); negative in SH — preserve sign
        const f  = 2 * OMEGA * Math.sin(latRad);
        const fC = (f >= 0 ? 1 : -1) * Math.max(Math.abs(f), F_MIN);
        const inv_rf = 1 / (RHO * fC);

        for (let ix = 0; ix < gW; ix++) {
            const iy0 = Math.max(0, iy - 1), iy1 = Math.min(gH - 1, iy + 1);
            const ix0 = Math.max(0, ix - 1), ix1 = Math.min(gW - 1, ix + 1);

            // Central-difference pressure gradients; hPa → Pa via ×100
            const dp_dy = (pressureGrid[iy1 * gW + ix] - pressureGrid[iy0 * gW + ix])
                        / ((iy1 - iy0) * dy) * 100;
            const dp_dx = (pressureGrid[iy * gW + ix1] - pressureGrid[iy * gW + ix0])
                        / ((ix1 - ix0) * dx) * 100;

            windU[iy * gW + ix] = -inv_rf * dp_dy;
            windV[iy * gW + ix] =  inv_rf * dp_dx;

            const spd = Math.sqrt(windU[iy * gW + ix] ** 2 + windV[iy * gW + ix] ** 2);
            if (spd > maxSpd) maxSpd = spd;
        }
    }

    // Normalise windSpd 0→1 for visual intensity (independent of ERA5 scale)
    const norm = maxSpd > 0 ? 1 / maxSpd : 1;
    for (let i = 0; i < gH * gW; i++) {
        windSpd[i] = Math.sqrt(windU[i] ** 2 + windV[i] ** 2) * norm;
    }
}

// ── Arrow state ────────────────────────────────────────────────────────────────
const ax       = new Float32Array(MAX_ARROWS);
const ay       = new Float32Array(MAX_ARROWS);
const aLife    = new Float32Array(MAX_ARROWS);
const aMaxLife = new Float32Array(MAX_ARROWS);
const aDir     = new Float32Array(MAX_ARROWS);

const iAlpha = new Float32Array(MAX_ARROWS);
const iSpeed = new Float32Array(MAX_ARROWS);
const iDir   = new Float32Array(MAX_ARROWS);
const iDiv   = new Float32Array(MAX_ARROWS);
const iVort  = new Float32Array(MAX_ARROWS);

// ── Trail ring-buffer state ─────────────────────────────────────────────────────
const TRAIL_MAX       = 120;
const MAX_TRAIL_INST  = MAX_ARROWS * TRAIL_MAX;      // 1,200,000 capacity

const axHist    = new Float32Array(MAX_ARROWS * TRAIL_MAX);
const ayHist    = new Float32Array(MAX_ARROWS * TRAIL_MAX);
const aHistHead = new Uint8Array(MAX_ARROWS);        // ring buffer write pointer
const aHistCount= new Uint8Array(MAX_ARROWS);        // valid entries (0→TRAIL_MAX)

const tAlpha = new Float32Array(MAX_TRAIL_INST);
const tSpeed = new Float32Array(MAX_TRAIL_INST);
const tDir   = new Float32Array(MAX_TRAIL_INST);
const tDiv   = new Float32Array(MAX_TRAIL_INST);
const tVort  = new Float32Array(MAX_TRAIL_INST);
let trailMesh = null;

// ── Wind field background texture ──────────────────────────────────────────────
let windTexData = null, windTex = null, _bgMat = null;

function initBackground() {
    windTexData = new Uint8Array(windW * windH * 4);
    windTex = new THREE.DataTexture(windTexData, windW, windH, THREE.RGBAFormat);
    windTex.magFilter = THREE.LinearFilter;
    windTex.minFilter = THREE.LinearFilter;
    // Crop the texture to the VIEW window so only the North Atlantic is shown
    const lonStep = 350 / (windW - 1), latStep = 170 / (windH - 1);
    const uMin = (VIEW.lonMin + 175) / lonStep / windW;
    const uMax = (VIEW.lonMax + 175) / lonStep / windW;
    const vMin = (VIEW.latMin +  85) / latStep / windH;
    const vMax = (VIEW.latMax +  85) / latStep / windH;
    windTex.offset.set(uMin, vMin);
    windTex.repeat.set(uMax - uMin, vMax - vMin);

    const bgGeo = new THREE.PlaneGeometry(RENDER_W, RENDER_H);
    _bgMat = new THREE.MeshBasicMaterial({
        map:         windTex,
        transparent: true,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
        opacity:     params.windOpacity,
    });
    const bgMesh = new THREE.Mesh(bgGeo, _bgMat);
    bgMesh.position.z = -0.5;
    scene.add(bgMesh);

    updateWindTexture();
}

// Write current windSpd values into the DataTexture as a blue-cyan glow.
// The 36×18 texture is rendered with LinearFilter so the coarse grid reads as
// smooth atmospheric blobs — the storm shows up as a persistent bright region.
function updateWindTexture() {
    if (!windTexData) return;
    for (let i = 0; i < windH * windW; i++) {
        const s = windSpd[i];            // 0..1 normalised
        windTexData[i * 4]     = Math.floor(s * s * 60);   // R — faint in high wind
        windTexData[i * 4 + 1] = Math.floor(s * 140);      // G — medium
        windTexData[i * 4 + 2] = Math.floor(s * 255);      // B — full
        windTexData[i * 4 + 3] = Math.floor(s * 210);      // A — near-opaque at peak
    }
    windTex.needsUpdate = true;
}

// ── InstancedMesh ──────────────────────────────────────────────────────────────
let mesh;
const dummy = new THREE.Object3D();

function initMesh() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(UNIT_VERTS.slice(), 3));
    geo.setAttribute('fade',     new THREE.BufferAttribute(UNIT_FADE.slice(),  1));

    const mat = new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms: {
            uHueOffset:   { value: params.hueOffset },
            uHueRange:    { value: params.hueRange },
            uSaturation:  { value: params.saturation },
            uLightness:   { value: params.lightness },
            uBrightFloor: { value: params.brightFloor },
            uSpeedColour: { value: params.speedColour },
            uDivColour:   { value: params.divColour },
            uVortColour:  { value: params.vortColour },
        },
        side:        THREE.DoubleSide,
        blending:    THREE.NormalBlending,
        transparent: true,
        depthWrite:  false,
        depthTest:   false,
    });

    mesh = new THREE.InstancedMesh(geo, mat, MAX_ARROWS);
    mesh.frustumCulled = false;

    mesh.geometry.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(iAlpha, 1));
    mesh.geometry.setAttribute('iSpeed', new THREE.InstancedBufferAttribute(iSpeed, 1));
    mesh.geometry.setAttribute('iDir',   new THREE.InstancedBufferAttribute(iDir,   1));
    mesh.geometry.setAttribute('iDiv',   new THREE.InstancedBufferAttribute(iDiv,   1));
    mesh.geometry.setAttribute('iVort',  new THREE.InstancedBufferAttribute(iVort,  1));

    scene.add(mesh);
}

// ── Trail mesh ─────────────────────────────────────────────────────────────────
function initTrailMesh() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
        -0.5,-0.5,0,  0.5,-0.5,0,  0.5,0.5,0,
        -0.5,-0.5,0,  0.5, 0.5,0, -0.5,0.5,0,
    ]), 3));
    geo.setAttribute('fade', new THREE.BufferAttribute(new Float32Array(6).fill(1), 1));

    trailMesh = new THREE.InstancedMesh(geo, mesh.material, MAX_TRAIL_INST);
    trailMesh.frustumCulled = false;
    trailMesh.count = 0;
    trailMesh.position.z = -0.1;   // just behind arrows

    trailMesh.geometry.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(tAlpha, 1));
    trailMesh.geometry.setAttribute('iSpeed', new THREE.InstancedBufferAttribute(tSpeed, 1));
    trailMesh.geometry.setAttribute('iDir',   new THREE.InstancedBufferAttribute(tDir,   1));
    trailMesh.geometry.setAttribute('iDiv',   new THREE.InstancedBufferAttribute(tDiv,   1));
    trailMesh.geometry.setAttribute('iVort',  new THREE.InstancedBufferAttribute(tVort,  1));
    scene.add(trailMesh);
}

function updateTrails(activeCount) {
    if (!trailMesh) return;
    const tLen = Math.round(params.trailLength);
    if (tLen === 0) { trailMesh.count = 0; return; }

    let ti = 0;
    const dotScale = params.scale * 0.08;   // small dots — bloom would smear larger ones

    for (let i = 0; i < activeCount; i++) {
        const steps = Math.min(tLen, aHistCount[i]);
        for (let j = 1; j < steps; j++) {   // j=1: skip slot at current position
            const hi = ((aHistHead[i] - 1 - j) % TRAIL_MAX + TRAIL_MAX) % TRAIL_MAX;
            const ageFrac = j / tLen;        // 0=newest, 1=oldest

            const fade = (1 - ageFrac) * (1 - ageFrac);   // quadratic — drops fast
            tAlpha[ti] = iAlpha[i] * fade * 0.5;          // cap at half arrow brightness
            tSpeed[ti] = iSpeed[i];
            tDir[ti]   = iDir[i];
            tDiv[ti]   = iDiv[i];
            tVort[ti]  = iVort[i];

            dummy.position.set(axHist[i * TRAIL_MAX + hi], ayHist[i * TRAIL_MAX + hi], -0.1);
            dummy.rotation.z = 0;
            dummy.scale.setScalar(dotScale);
            dummy.updateMatrix();
            trailMesh.setMatrixAt(ti, dummy.matrix);
            ti++;
        }
    }
    trailMesh.count = ti;
    trailMesh.instanceMatrix.needsUpdate             = true;
    trailMesh.geometry.attributes.iAlpha.needsUpdate = true;
    trailMesh.geometry.attributes.iSpeed.needsUpdate = true;
    trailMesh.geometry.attributes.iDir.needsUpdate   = true;
    trailMesh.geometry.attributes.iDiv.needsUpdate   = true;
    trailMesh.geometry.attributes.iVort.needsUpdate  = true;
}

// ── Spawn ──────────────────────────────────────────────────────────────────────
function spawn(i, stagger = false) {
    // Bias spawn toward high-wind regions so storm patterns emerge from the data.
    // Try up to 8 candidate positions; accept with probability (0.15 + 0.85 * speed).
    // The 0.15 floor ensures calm areas are never completely empty.
    let px = (Math.random() - 0.5) * RENDER_W;
    let py = (Math.random() - 0.5) * RENDER_H;
    let w0 = bilinear(px, py);
    for (let attempt = 0; attempt < 8; attempt++) {
        if (Math.random() < 0.15 + 0.85 * w0.spd) break;
        px = (Math.random() - 0.5) * RENDER_W;
        py = (Math.random() - 0.5) * RENDER_H;
        w0 = bilinear(px, py);
    }
    ax[i]       = px;
    ay[i]       = py;
    aMaxLife[i] = params.lifeMin + Math.random() * (params.lifeMax - params.lifeMin);
    aLife[i]    = stagger ? Math.random() * aMaxLife[i] : 0;
    aDir[i]     = Math.atan2(w0.v, w0.u);
    aHistHead[i]  = 0;
    aHistCount[i] = 0;
}

// ── Update ─────────────────────────────────────────────────────────────────────
const statusEl = document.getElementById('status');

function update() {
    // Advance frame animation — interpolate wind field between ERA5 snapshots
    if (allFrames.length > 1) {
        frameFrac += 1 / params.frameDuration;
        if (frameFrac >= 1) {
            frameFrac -= 1;
            frameIdx = (frameIdx + 1) % allFrames.length;
            statusEl.textContent = allFrames[frameIdx].time;
        }
        interpolateWindField();
        computeDivergenceGrid();   // must run on ERA5 wind, before geostrophic override
        computeVorticityGrid();
        if (hasPressure) {
            interpolatePressure();
            computeGeostrophicWind();  // replaces ERA5 surface wind with geostrophic
            // Track pressure range for per-arrow intensity normalisation
            presFrameMin = Infinity; presFrameMax = -Infinity;
            for (let k = 0; k < windH * windW; k++) {
                if (pressureGrid[k] < presFrameMin) presFrameMin = pressureGrid[k];
                if (pressureGrid[k] > presFrameMax) presFrameMax = pressureGrid[k];
            }
        }
        updateWindTexture();
        updateIsobars();
    }

    const activeCount = Math.min(params.arrowCount, MAX_ARROWS);

    for (let i = 0; i < MAX_ARROWS; i++) {
        if (i >= activeCount) { iAlpha[i] = 0; continue; }

        aLife[i]++;
        if (aLife[i] >= aMaxLife[i]) spawn(i);

        const w     = bilinear(ax[i], ay[i]);
        const angle = Math.atan2(w.v, w.u);

        ax[i] += w.u * params.flowSpeed;
        ay[i] += w.v * params.flowSpeed;

        // Respawn when an arrow exits any edge — no wrapping.
        // A small overshoot margin lets the arrow visibly cross the border
        // before disappearing, so exits look natural rather than abrupt.
        const MARGIN = 30;
        if (ax[i] >  HALF_W + MARGIN || ax[i] < -HALF_W - MARGIN ||
            ay[i] >  HALF_H + MARGIN || ay[i] < -HALF_H - MARGIN) spawn(i);

        if (params.trailLength > 0) {
            axHist[i * TRAIL_MAX + aHistHead[i]] = ax[i];
            ayHist[i * TRAIL_MAX + aHistHead[i]] = ay[i];
            aHistHead[i] = (aHistHead[i] + 1) % TRAIL_MAX;
            if (aHistCount[i] < TRAIL_MAX) aHistCount[i]++;
        }

        // Smooth colour direction — shortest-arc lerp across ±π boundary
        let diff = angle - aDir[i];
        if (diff >  Math.PI) diff -= Math.PI * 2;
        if (diff < -Math.PI) diff += Math.PI * 2;
        aDir[i] += diff * params.colourSmooth;

        const t    = aLife[i] / aMaxLife[i];
        const frac = params.fadeFrames / aMaxLife[i];
        const alpha = t < frac
            ? t / frac
            : t > 1 - frac ? (1 - t) / frac : 1.0;

        iAlpha[i] = Math.max(0, Math.min(1, alpha)) * (params.alphaMin + (1 - params.alphaMin) * w.spd);
        iSpeed[i] = w.spd;
        iDir[i]   = (aDir[i] + Math.PI) / (Math.PI * 2);
        // Intensity signal: pressure depth gives the reference-image gradient (low=red, ambient=blue).
        // ERA5 divergence is the fallback when no pressure data is loaded.
        if (hasPressure && presFrameMin < 1013) {
            // Anchor zero at 1013 hPa (standard atmosphere) so ambient air stays blue.
            // Only sub-1013 pressure drives the gradient: edge=green, center=red.
            const range = 1013 - presFrameMin;   // hPa drop to deepest low in frame
            const depth = Math.max(0, (1013 - w.pres) / range);
            iDiv[i] = Math.min(1, depth * params.intensityBoost);
        } else {
            iDiv[i] = w.div;
        }
        iVort[i] = Math.min(1, w.vort * params.intensityBoost);

        const s = params.scale;
        dummy.position.set(ax[i], ay[i], 0);
        dummy.rotation.z = angle;
        dummy.scale.setScalar(s * 0.9 + s * 0.2 * w.spd);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
    }

    mesh.instanceMatrix.needsUpdate             = true;
    mesh.geometry.attributes.iAlpha.needsUpdate = true;
    mesh.geometry.attributes.iSpeed.needsUpdate = true;
    mesh.geometry.attributes.iDir.needsUpdate   = true;
    mesh.geometry.attributes.iDiv.needsUpdate   = true;
    mesh.geometry.attributes.iVort.needsUpdate  = true;

    updateTrails(activeCount);
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

    bind('arrow-count',    'arrow-count-val',    v => Math.round(v),  v => { params.arrowCount = v; });
    bind('flow-speed',     'flow-speed-val',     v => v.toFixed(2),   v => { params.flowSpeed = v; });
    bind('scale',          'scale-val',          v => v.toFixed(0),   v => { params.scale = v; });
    bind('alpha-min',      'alpha-min-val',      v => v.toFixed(2),   v => { params.alphaMin = v; });
    bind('life-min',       'life-min-val',       v => Math.round(v),  v => { params.lifeMin = v; });
    bind('life-max',       'life-max-val',       v => Math.round(v),  v => { params.lifeMax = v; });
    bind('fade-frames',    'fade-frames-val',    v => Math.round(v),  v => { params.fadeFrames = v; });
    bind('frame-duration', 'frame-duration-val', v => Math.round(v),  v => { params.frameDuration = v; });

    bind('hue-offset',    'hue-offset-val',    v => v.toFixed(2), v => {
        params.hueOffset = v; mesh.material.uniforms.uHueOffset.value = v;
    });
    bind('hue-range',     'hue-range-val',     v => v.toFixed(2), v => {
        params.hueRange = v; mesh.material.uniforms.uHueRange.value = v;
    });
    bind('saturation',    'saturation-val',    v => v.toFixed(2), v => {
        params.saturation = v; mesh.material.uniforms.uSaturation.value = v;
    });
    bind('lightness',     'lightness-val',     v => v.toFixed(2), v => {
        params.lightness = v; mesh.material.uniforms.uLightness.value = v;
    });
    bind('bright-floor',  'bright-floor-val',  v => v.toFixed(2), v => {
        params.brightFloor = v; mesh.material.uniforms.uBrightFloor.value = v;
    });
    bind('colour-smooth', 'colour-smooth-val', v => v.toFixed(2), v => { params.colourSmooth = v; });

    bind('bloom-strength', 'bloom-strength-val', v => v.toFixed(1), v => { bloomPass.strength  = v; });
    bind('bloom-radius',   'bloom-radius-val',   v => v.toFixed(2), v => { bloomPass.radius    = v; });
    bind('bloom-thresh',   'bloom-thresh-val',   v => v.toFixed(2), v => { bloomPass.threshold = v; });

    bind('map-opacity', 'map-opacity-val', v => v.toFixed(2), v => {
        params.mapOpacity = v;
        if (_mapMat) _mapMat.opacity = v;
    });
    bind('wind-opacity', 'wind-opacity-val', v => v.toFixed(2), v => {
        params.windOpacity = v;
        if (_bgMat) _bgMat.opacity = v;
    });
    bind('isobar-opacity', 'isobar-opacity-val', v => v.toFixed(2), v => {
        ISOBAR_PARAMS.opacity = v;
        if (_isobarMat) _isobarMat.opacity = v;
    });

    bind('speed-colour', 'speed-colour-val', v => v.toFixed(2), v => {
        params.speedColour = v;
        mesh.material.uniforms.uSpeedColour.value = v;
    });
    bind('div-colour', 'div-colour-val', v => v.toFixed(2), v => {
        params.divColour = v;
        mesh.material.uniforms.uDivColour.value = v;
    });
    bind('vort-colour', 'vort-colour-val', v => v.toFixed(2), v => {
        params.vortColour = v;
        mesh.material.uniforms.uVortColour.value = v;
    });
    bind('intensity-boost', 'intensity-boost-val', v => v.toFixed(1), v => { params.intensityBoost = v; });

    bind('trail-length', 'trail-length-val', v => Math.round(v), v => { params.trailLength = v; });
}

// ── Synthetic wind fallback ────────────────────────────────────────────────────
function makeSyntheticWind() {
    const VORTICES = [
        { lat: 45, lon: -45,  str: 14, r: 18, spin:  1 },
        { lat: 30, lon: -140, str: 10, r: 14, spin: -1 },
        { lat: 55, lon:  15,  str:  9, r: 15, spin:  1 },
        { lat:-40, lon: -30,  str: 11, r: 16, spin: -1 },
        { lat:-55, lon:  120, str: 12, r: 18, spin: -1 },
        { lat: 20, lon: -70,  str:  8, r:  8, spin:  1 },
        { lat: 15, lon:  140, str: 13, r: 10, spin: -1 },
    ];
    const W = 72, H = 36;
    const u = new Float32Array(W * H);
    const v = new Float32Array(W * H);
    const s = new Float32Array(W * H);
    for (let iy = 0; iy < H; iy++) {
        const lat = -87.5 + iy * 5, latr = lat * Math.PI / 180;
        for (let ix = 0; ix < W; ix++) {
            const lon = -177.5 + ix * 5, lonr = lon * Math.PI / 180;
            const idx = iy * W + ix;
            let uv = -12*Math.cos(latr)*Math.sin(latr*2)
                     +18*Math.pow(Math.sin(latr),3)*Math.cos(latr)
                     + 6*Math.cos(latr)*Math.cos(lonr*3)
                     - 4*Math.sin(latr*latr)*Math.sin(lonr*2);
            let vv =  4*Math.cos(lonr*4)*Math.cos(latr)
                     + 3*Math.sin(latr*2)*Math.sin(lonr*2);
            for (const vc of VORTICES) {
                let dlat = lat - vc.lat, dlon = lon - vc.lon;
                if (dlon >  180) dlon -= 360;
                if (dlon < -180) dlon += 360;
                const dist = Math.sqrt(dlat*dlat + dlon*dlon);
                if (dist < vc.r * 3.5 && dist > 0.5) {
                    const f = vc.str * Math.exp(-((dist/vc.r)**2));
                    uv += f * (-vc.spin * dlon / (dist + 1));
                    vv += f * ( vc.spin * dlat / (dist + 1));
                }
            }
            u[idx] = uv; v[idx] = vv;
            s[idx] = Math.sqrt(uv**2 + vv**2);
        }
    }
    const mx = Math.max(...s) || 1;
    for (let i = 0; i < s.length; i++) s[i] /= mx;
    windW = W; windH = H; windU = u; windV = v; windSpd = s;
}

// ── Map background (Natural Earth land polygons via world-atlas TopoJSON) ───────
// Draws land as filled polygons onto a canvas in equirectangular projection so
// coastlines align exactly with the wind coordinate system. No tile projection
// mismatch, no CORS issues, full control over land colour.
let _mapMat = null;

async function loadMapBackground() {
    try {
        const [{ feature }, world] = await Promise.all([
            import('https://cdn.skypack.dev/topojson-client@3'),
            fetch('https://unpkg.com/world-atlas@2/land-110m.json').then(r => r.json()),
        ]);

        // topojson.feature returns a Feature (not FeatureCollection) for land-110m
        const land = feature(world, world.objects.land);

        // Canvas: y=0 = top = north (CanvasTexture flipY=true maps canvas top → plane top)
        const lc  = document.createElement('canvas');
        lc.width  = RENDER_W;
        lc.height = RENDER_H;
        const ctx = lc.getContext('2d');

        // Equirectangular projection matching our wind grid coordinate system
        const lonToX = lon => (lon - VIEW.lonMin) / (VIEW.lonMax - VIEW.lonMin) * RENDER_W;
        const latToY = lat => (VIEW.latMax - lat) / (VIEW.latMax - VIEW.latMin) * RENDER_H;

        function drawRing(coords) {
            if (!coords.length) return;
            ctx.moveTo(lonToX(coords[0][0]), latToY(coords[0][1]));
            for (let i = 1; i < coords.length; i++) {
                // Antimeridian crossing: longitude jumps > 180° (Russia, Antarctica, etc.)
                // Use moveTo to break the path instead of drawing a line across the canvas.
                if (Math.abs(coords[i][0] - coords[i - 1][0]) > 180) {
                    ctx.moveTo(lonToX(coords[i][0]), latToY(coords[i][1]));
                } else {
                    ctx.lineTo(lonToX(coords[i][0]), latToY(coords[i][1]));
                }
            }
        }

        function drawGeom(geom) {
            if (!geom) return;
            if (geom.type === 'Polygon') {
                geom.coordinates.forEach(drawRing);
            } else if (geom.type === 'MultiPolygon') {
                geom.coordinates.forEach(poly => poly.forEach(drawRing));
            }
        }

        ctx.strokeStyle = 'rgba(255, 255, 255, 1.0)';  // white keyline coastlines
        ctx.lineWidth   = 2.5;
        ctx.beginPath();
        if (land.features) land.features.forEach(f => drawGeom(f.geometry));
        else drawGeom(land.geometry);
        ctx.stroke();

        const mapTex = new THREE.CanvasTexture(lc);
        mapTex.magFilter = THREE.LinearFilter;
        mapTex.minFilter = THREE.LinearFilter;

        _mapMat = new THREE.MeshBasicMaterial({
            map:         mapTex,
            transparent: true,
            blending:    THREE.NormalBlending,
            depthWrite:  false,
            opacity:     params.mapOpacity,
        });
        const mapMesh = new THREE.Mesh(new THREE.PlaneGeometry(RENDER_W, RENDER_H), _mapMat);
        mapMesh.position.z = -1;
        scene.add(mapMesh);
    } catch (err) {
        console.warn('Map background failed:', err);
    }
}

// ── Pressure isobars (marching squares) ────────────────────────────────────────
// Contour lines drawn onto a CanvasTexture, updated once per data-frame change.
// Run add_pressure.py first to populate the "pressure" field in frame JSONs.

// Corners: TL=8, TR=4, BR=2, BL=1  |  Edges: 0=top, 1=right, 2=bottom, 3=left
const MS_LINES = [
    [],              // 0:  0000
    [[3,2]],         // 1:  0001 BL
    [[1,2]],         // 2:  0010 BR
    [[3,1]],         // 3:  0011 BL+BR
    [[0,1]],         // 4:  0100 TR
    [[0,3],[1,2]],   // 5:  0101 TR+BL  saddle A
    [[0,2]],         // 6:  0110 TR+BR
    [[0,3]],         // 7:  0111 TR+BR+BL
    [[0,3]],         // 8:  1000 TL
    [[0,2]],         // 9:  1001 TL+BL
    [[0,1],[2,3]],   // 10: 1010 TL+BR  saddle B
    [[0,1]],         // 11: 1011 TL+BR+BL
    [[1,3]],         // 12: 1100 TL+TR
    [[1,2]],         // 13: 1101 TL+TR+BL
    [[2,3]],         // 14: 1110 TL+TR+BR
    [],              // 15: 1111
];

let _isobarMat    = null;
let _isobarCanvas = null;
let _isobarTex    = null;

// H/L label state — detected once per data-frame change, then interpolated.
let _hlPairs             = [];   // [{isMin, cxA,cyA,pA, cxB,cyB,pB}]
let _hlLastDetectedFrame = -1;

const ISOBAR_PARAMS = {
    opacity:   0.7,
    minHPa:    928,
    maxHPa:    1044,
    stepMinor: 4,    // draw every 4 hPa
    stepMajor: 20,   // thicker + labelled every 20 hPa
    fine:      14,   // bilinear subdivision factor — higher = smoother contours
};

function initIsobars() {
    if (!hasPressure) return;

    _isobarCanvas        = document.createElement('canvas');
    _isobarCanvas.width  = RENDER_W;
    _isobarCanvas.height = RENDER_H;

    _isobarTex = new THREE.CanvasTexture(_isobarCanvas);
    _isobarTex.magFilter = THREE.LinearFilter;
    _isobarTex.minFilter = THREE.LinearFilter;

    _isobarMat = new THREE.MeshBasicMaterial({
        map:         _isobarTex,
        transparent: true,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
        opacity:     ISOBAR_PARAMS.opacity,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(RENDER_W, RENDER_H), _isobarMat);
    mesh.position.z = 0.6;   // above wind field, below marker and grid
    scene.add(mesh);

    drawIsobars();
}

// Scan a raw pressure grid for local extrema within the VIEW window.
// Returns [{isMin, cx, cy, p}] in canvas coordinates.
// Uses the coarse 36×18 grid with parabolic sub-cell refinement.
function detectCoarseHL(pg) {
    const gW2 = windW, gH2 = windH;
    const latStepG = 170 / (gH2 - 1);
    const lonStepG = 350 / (gW2 - 1);
    const results = [];

    for (let iy = 1; iy < gH2 - 1; iy++) {
        const latDeg = -85 + iy * latStepG;
        for (let ix = 1; ix < gW2 - 1; ix++) {
            const lonDeg = -175 + ix * lonStepG;
            if (lonDeg < VIEW.lonMin || lonDeg > VIEW.lonMax ||
                latDeg < VIEW.latMin || latDeg > VIEW.latMax) continue;

            const p = pg[iy * gW2 + ix];
            let isMin = true, isMax = true;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dy === 0 && dx === 0) continue;
                    const np = pg[(iy + dy) * gW2 + (ix + dx)];
                    if (np <= p) isMin = false;
                    if (np >= p) isMax = false;
                }
            }
            if (!isMin && !isMax) continue;
            if (isMin && p > 1008) continue;
            if (isMax && p < 1018) continue;

            // Parabolic sub-cell refinement for smoother label placement
            let subIx = ix, subIy = iy;
            const pL = pg[iy * gW2 + ix - 1], pR = pg[iy * gW2 + ix + 1];
            const pU = pg[(iy - 1) * gW2 + ix], pD = pg[(iy + 1) * gW2 + ix];
            const dX = pL - 2 * p + pR, dY = pU - 2 * p + pD;
            if (Math.abs(dX) > 1e-6) subIx -= 0.5 * (pR - pL) / dX;
            if (Math.abs(dY) > 1e-6) subIy -= 0.5 * (pD - pU) / dY;

            const lonR = -175 + subIx * lonStepG;
            const latR = -85  + subIy * latStepG;
            results.push({
                isMin,
                cx: (lonR - VIEW.lonMin) / (VIEW.lonMax - VIEW.lonMin) * RENDER_W,
                cy: (VIEW.latMax - latR) / (VIEW.latMax - VIEW.latMin) * RENDER_H,
                p,
            });
        }
    }
    return results;
}

function drawIsobars() {
    if (!hasPressure || !_isobarCanvas) return;

    const { minHPa, maxHPa, stepMinor, stepMajor, fine } = ISOBAR_PARAMS;
    const gW = windW, gH = windH;

    // Build fine pressure grid by bilinear interpolation of pressureGrid.
    // Canvas y=0 = VIEW.latMax (north); pressureGrid row 0 = lat -85 (south).
    const fW = (gW - 1) * fine + 1;
    const fH = (gH - 1) * fine + 1;
    const fp  = new Float32Array(fW * fH);

    const lonStep = 350 / (gW - 1);
    const latStep = 170 / (gH - 1);

    for (let fy = 0; fy < fH; fy++) {
        // Canvas y=0→fH maps to lat VIEW.latMax→VIEW.latMin
        const lat = VIEW.latMax - fy / (fH - 1) * (VIEW.latMax - VIEW.latMin);
        const gy  = (lat + 85) / latStep;
        const gy0 = Math.max(0, Math.min(gH - 2, Math.floor(gy)));
        const gy1 = gy0 + 1;
        const ty  = gy - gy0;

        for (let fx = 0; fx < fW; fx++) {
            const lon  = VIEW.lonMin + fx / (fW - 1) * (VIEW.lonMax - VIEW.lonMin);
            const gx   = (lon + 175) / lonStep;
            const gx0  = Math.max(0, Math.min(gW - 2, Math.floor(gx)));
            const gx1  = gx0 + 1;
            const tx   = gx - gx0;

            const p00 = pressureGrid[gy0 * gW + gx0];
            const p10 = pressureGrid[gy0 * gW + gx1];
            const p01 = pressureGrid[gy1 * gW + gx0];
            const p11 = pressureGrid[gy1 * gW + gx1];
            fp[fy * fW + fx] = p00*(1-tx)*(1-ty) + p10*tx*(1-ty)
                              + p01*(1-tx)*ty     + p11*tx*ty;
        }
    }

    const ctx = _isobarCanvas.getContext('2d');
    ctx.clearRect(0, 0, RENDER_W, RENDER_H);

    // Edge-point interpolation for one MS edge
    const edgePt = (edge, tl, tr, bl, br, px0, py0, px1, py1, lvl) => {
        const lerp = (v0, v1, a0, a1) => {
            const t = Math.abs(v1 - v0) < 1e-6 ? 0.5
                      : Math.max(0, Math.min(1, (lvl - v0) / (v1 - v0)));
            return a0 + t * (a1 - a0);
        };
        switch (edge) {
            case 0: return [lerp(tl, tr, px0, px1), py0]; // top:   TL→TR
            case 1: return [px1, lerp(tr, br, py0, py1)]; // right: TR→BR
            case 2: return [lerp(bl, br, px0, px1), py1]; // bot:   BL→BR
            case 3: return [px0, lerp(tl, bl, py0, py1)]; // left:  TL→BL
        }
    };

    // Gaussian smooth the fine grid — removes kinks in the pressure field
    // that would otherwise cause sharp angles in the contour lines.
    {
        const tmp = new Float32Array(fp.length);
        for (let pass = 0; pass < 3; pass++) {
            for (let y = 0; y < fH; y++)
                for (let x = 0; x < fW; x++) {
                    const x0 = Math.max(0,x-1), x2 = Math.min(fW-1,x+1);
                    tmp[y*fW+x] = 0.25*fp[y*fW+x0] + 0.5*fp[y*fW+x] + 0.25*fp[y*fW+x2];
                }
            for (let y = 0; y < fH; y++) {
                const y0 = Math.max(0,y-1), y2 = Math.min(fH-1,y+1);
                for (let x = 0; x < fW; x++)
                    fp[y*fW+x] = 0.25*tmp[y0*fW+x] + 0.5*tmp[y*fW+x] + 0.25*tmp[y2*fW+x];
            }
        }
    }

    // Collect raw marching-squares segments for one isobar level.
    const collectSegs = (lvl) => {
        const segs = [];
        for (let fy = 0; fy < fH - 1; fy++) {
            for (let fx = 0; fx < fW - 1; fx++) {
                const tl = fp[ fy      * fW + fx    ];
                const tr = fp[ fy      * fW + fx + 1];
                const bl = fp[(fy + 1) * fW + fx    ];
                const br = fp[(fy + 1) * fW + fx + 1];
                const ci = ((tl>lvl)?8:0)|((tr>lvl)?4:0)|((br>lvl)?2:0)|((bl>lvl)?1:0);
                const ms = MS_LINES[ci];
                if (!ms.length) continue;
                const px0 = fx       / (fW-1) * RENDER_W;
                const px1 = (fx + 1) / (fW-1) * RENDER_W;
                const py0 = fy       / (fH-1) * RENDER_H;
                const py1 = (fy + 1) / (fH-1) * RENDER_H;
                for (const [e0,e1] of ms) {
                    const [ax,ay] = edgePt(e0,tl,tr,bl,br,px0,py0,px1,py1,lvl);
                    const [bx,by] = edgePt(e1,tl,tr,bl,br,px0,py0,px1,py1,lvl);
                    segs.push([ax,ay,bx,by]);
                }
            }
        }
        return segs;
    };

    // Chain isolated segments into continuous polylines using an endpoint map.
    const buildChains = (segs) => {
        const R   = 10;
        const key = (x,y) => `${Math.round(x*R)},${Math.round(y*R)}`;
        const adj = new Map();
        segs.forEach(([x0,y0,x1,y1],i) => {
            const k0=key(x0,y0), k1=key(x1,y1);
            if (!adj.has(k0)) adj.set(k0,[]);
            if (!adj.has(k1)) adj.set(k1,[]);
            adj.get(k0).push([i,0]);
            adj.get(k1).push([i,1]);
        });
        const used = new Uint8Array(segs.length);
        const chains = [];
        for (let si = 0; si < segs.length; si++) {
            if (used[si]) continue;
            used[si] = 1;
            const [x0,y0,x1,y1] = segs[si];
            const ch = [[x0,y0],[x1,y1]];
            const extend = (end) => {
                for (;;) {
                    const pt = end ? ch[ch.length-1] : ch[0];
                    const nbrs = adj.get(key(pt[0],pt[1])) || [];
                    let ok = false;
                    for (const [ni,ei] of nbrs) {
                        if (used[ni]) continue;
                        used[ni] = 1;
                        const [nx0,ny0,nx1,ny1] = segs[ni];
                        end ? ch.push(ei===0?[nx1,ny1]:[nx0,ny0])
                            : ch.unshift(ei===1?[nx0,ny0]:[nx1,ny1]);
                        ok = true; break;
                    }
                    if (!ok) break;
                }
            };
            extend(true); extend(false);
            chains.push(ch);
        }
        return chains;
    };

    // Draw a polyline as a smooth curve via the midpoint quadratic-bezier method.
    // Each original vertex becomes a bezier control point; midpoints are on-curve.
    // This produces C1-continuous curves with no visible angle at any join.
    const drawChain = (ch) => {
        if (ch.length < 2) return;
        const mid = (a,b) => [(a[0]+b[0])*0.5,(a[1]+b[1])*0.5];
        const m0 = mid(ch[0],ch[1]);
        ctx.moveTo(m0[0],m0[1]);
        for (let i = 1; i < ch.length-1; i++) {
            const m = mid(ch[i],ch[i+1]);
            ctx.quadraticCurveTo(ch[i][0],ch[i][1],m[0],m[1]);
        }
        ctx.lineTo(ch[ch.length-1][0],ch[ch.length-1][1]);
    };

    const strokeLevels = (levels) => {
        ctx.beginPath();
        for (const lvl of levels) buildChains(collectSegs(lvl)).forEach(drawChain);
        ctx.stroke();
    };

    // ── Pass 1: minor isobars ─────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(110, 170, 230, 0.30)';
    ctx.lineWidth   = 0.8;
    const minorLvls = [];
    for (let lvl = minHPa; lvl <= maxHPa; lvl += stepMinor)
        if (lvl % stepMajor !== 0) minorLvls.push(lvl);
    strokeLevels(minorLvls);

    // ── Pass 2: major isobars ─────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(180, 220, 255, 0.70)';
    ctx.lineWidth   = 1.5;
    const majorLvls = [];
    for (let lvl = minHPa; lvl <= maxHPa; lvl += stepMajor) majorLvls.push(lvl);
    strokeLevels(majorLvls);

    // ── Pass 3: major isobar labels ───────────────────────────────────────────
    ctx.font         = "bold 10px 'Space Mono', monospace";
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = 'rgba(180, 220, 255, 0.80)';
    for (let lvl = minHPa; lvl <= maxHPa; lvl += stepMajor) {
        outer:
        for (let fy = 8; fy < fH - 8; fy += 5) {
            for (let fx = 15; fx < fW - 15; fx++) {
                const tl = fp[fy * fW + fx];
                const tr = fp[fy * fW + fx + 1];
                if ((tl > lvl) !== (tr > lvl)) {
                    const t  = (lvl - tl) / (tr - tl + 1e-9);
                    const lx = (fx + t) / (fW - 1) * RENDER_W;
                    const ly = (fy + 0.5) / (fH - 1) * RENDER_H;
                    ctx.fillText(String(lvl), lx, ly - 7);
                    break outer;
                }
            }
        }
    }

    _isobarTex.needsUpdate = true;
}

let _isobarTick = 0;
function updateIsobars() {
    if (!hasPressure || !_isobarCanvas) return;
    if (++_isobarTick % 3 !== 0) return;   // ~20 fps — pressure changes slowly
    drawIsobars();   // pressureGrid already lerped this tick
}

// ── Sandy storm marker ─────────────────────────────────────────────────────────
let sandyMarker = null;

function initSandyMarker() {
    if (!allFrames.length) return;   // real data only

    const SIZE = 128, cx = 64, cy = 64, R = 38;
    const mc   = document.createElement('canvas');
    mc.width = mc.height = SIZE;
    const ctx  = mc.getContext('2d');

    ctx.strokeStyle = '#ff5030';
    ctx.fillStyle   = '#ff5030';
    ctx.lineWidth   = 2;
    ctx.shadowColor = '#ff5030';
    ctx.shadowBlur  = 12;

    // Ring
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();

    // Four tick marks
    [0, Math.PI / 2, Math.PI, Math.PI * 1.5].forEach(a => {
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * (R + 2),  cy + Math.sin(a) * (R + 2));
        ctx.lineTo(cx + Math.cos(a) * (R + 10), cy + Math.sin(a) * (R + 10));
        ctx.stroke();
    });

    // Centre dot
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Label
    ctx.shadowBlur   = 0;
    ctx.font         = "bold 11px 'Space Mono', monospace";
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('SANDY', cx, cy + R + 6);

    const tex  = new THREE.CanvasTexture(mc);
    sandyMarker = new THREE.Sprite(new THREE.SpriteMaterial({
        map:         tex,
        transparent: true,
        blending:    THREE.AdditiveBlending,
        depthWrite:  false,
    }));
    sandyMarker.scale.set(110, 110, 1);
    sandyMarker.position.z = 0.8;
    scene.add(sandyMarker);
    updateSandyMarker();
}

function updateSandyMarker() {
    if (!sandyMarker) return;
    const t0  = SANDY_TRACK[frameIdx];
    const t1  = SANDY_TRACK[Math.min(frameIdx + 1, SANDY_TRACK.length - 1)];
    const lat = t0.lat + (t1.lat - t0.lat) * frameFrac;
    const lon = t0.lon + (t1.lon - t0.lon) * frameFrac;
    const { x, y } = trackToWorld(lat, lon);
    sandyMarker.position.set(x, y, 0.8);
}

// ── Landmark overlay ───────────────────────────────────────────────────────────
// Named geographic reference points so you can verify map/wind alignment visually.
// Toggle with [G]. If "New York" sits on the New York coastline, the coordinate
// systems are correctly registered.
const LANDMARKS = [
    // Americas
    { name: 'New York',   lat: 40.7,  lon: -74.0 },
    { name: 'Miami',      lat: 25.8,  lon: -80.2 },
    { name: 'Havana',     lat: 23.1,  lon: -82.4 },
    { name: 'Halifax',    lat: 44.6,  lon: -63.6 },
    { name: 'Bermuda',    lat: 32.3,  lon: -64.8 },
    // Mid-Atlantic
    { name: 'Azores',     lat: 38.5,  lon: -28.6 },
    { name: 'Canaries',   lat: 28.1,  lon: -15.4 },
    // Europe / Africa
    { name: 'London',     lat: 51.5,  lon:  -0.1 },
    { name: 'Lisbon',     lat: 38.7,  lon:  -9.1 },
    { name: 'Madrid',     lat: 40.4,  lon:  -3.7 },
    { name: 'Reykjavik',  lat: 64.1,  lon: -21.9 },
    // Caribbean
    { name: 'Jamaica',    lat: 18.1,  lon: -77.3 },
    { name: 'Cuba E',     lat: 20.0,  lon: -75.8 },
];

let gridMesh = null;

function initGridOverlay() {
    const lc  = document.createElement('canvas');
    lc.width  = RENDER_W;
    lc.height = RENDER_H;
    const ctx = lc.getContext('2d');

    const toX = lon => (lon - VIEW.lonMin) / (VIEW.lonMax - VIEW.lonMin) * RENDER_W;
    const toY = lat => (VIEW.latMax - lat) / (VIEW.latMax - VIEW.latMin) * RENDER_H;

    for (const { name, lat, lon } of LANDMARKS) {
        const cx = toX(lon), cy = toY(lat);
        // Skip points outside VIEW
        if (cx < 0 || cx > RENDER_W || cy < 0 || cy > RENDER_H) continue;

        // Crosshair
        ctx.strokeStyle = 'rgba(255, 220, 80, 0.85)';
        ctx.lineWidth = 1;
        const A = 6;
        ctx.beginPath();
        ctx.moveTo(cx - A, cy); ctx.lineTo(cx + A, cy);
        ctx.moveTo(cx, cy - A); ctx.lineTo(cx, cy + A);
        ctx.stroke();

        // Dot
        ctx.fillStyle = 'rgba(255, 220, 80, 0.9)';
        ctx.beginPath();
        ctx.arc(cx, cy, 2, 0, Math.PI * 2);
        ctx.fill();

        // Label
        ctx.font         = "bold 10px 'Space Mono', monospace";
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle    = 'rgba(255, 220, 80, 0.9)';
        ctx.fillText(name, cx + 8, cy - 2);
    }

    const tex = new THREE.CanvasTexture(lc);
    const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true,
        blending: THREE.NormalBlending, depthWrite: false,
    });
    gridMesh = new THREE.Mesh(new THREE.PlaneGeometry(RENDER_W, RENDER_H), mat);
    gridMesh.position.z = 0.5;
    gridMesh.visible    = false;
    scene.add(gridMesh);
}

// ── Render loop ────────────────────────────────────────────────────────────────
function animate() {
    requestAnimationFrame(animate);
    update();
    composer.render();
}

// ── Keyboard ───────────────────────────────────────────────────────────────────
window.addEventListener('keydown', e => {
    if (e.code === 'KeyS') {
        composer.render();
        const a = document.createElement('a');
        a.download = `qw_${Date.now()}.png`;
        a.href = renderer.domElement.toDataURL('image/png');
        a.click();
    }
    if (e.code === 'KeyH') {
        document.getElementById('sidebar').classList.toggle('ui-hidden');
    }
    if (e.code === 'KeyG') {
        if (gridMesh) gridMesh.visible = !gridMesh.visible;
    }
    if (e.code === 'KeyT') {
        if (sandyMarker) sandyMarker.visible = !sandyMarker.visible;
    }
});

// ── Bootstrap ──────────────────────────────────────────────────────────────────
(async () => {
    try {
        await loadAllFrames();
        statusEl.textContent = allFrames[0].time;
    } catch (_) {
        makeSyntheticWind();
        computeDivergenceGrid();   // synthetic wind only — real frames handle this inside loadAllFrames
        computeVorticityGrid();
        statusEl.textContent = 'synthetic wind (frames not found)';
    }

    initMesh();
    initTrailMesh();
    initBackground();
    initIsobars();         // no-op until add_pressure.py has been run
    initGridOverlay();
    loadMapBackground();   // async — adds map mesh when ready
    setupControls();
    for (let i = 0; i < params.arrowCount; i++) spawn(i, true);
    animate();
})();
