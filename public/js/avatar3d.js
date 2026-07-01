// Arcadia 3D Avatar Renderer - Raw WebGL, no Three.js
(function() {
  'use strict';

  let gl = null;
  let canvas = null;
  let shaderProgram = null;
  let posBuffer = null;
  let normalBuffer = null;
  let indexBuffer = null;
  let lineIndexBuffer = null;
  let totalIndices = 0;
  let totalLineIndices = 0;

  let rotX = -0.25;
  let rotY = 0;
  let autoRotate = true;
  let dragging = false;
  let lastMX = 0, lastMY = 0;
  let animFrame = null;

  let currentBodyColor = [0, 0.635, 1];
  let currentFace = 'smile';
  let currentHat = 'none';
  let currentAccessory = 'none';

  const VS_SOURCE = `
    attribute vec3 aPos;
    attribute vec3 aNormal;
    uniform mat4 uMVP;
    uniform mat4 uModel;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    void main() {
      gl_Position = uMVP * vec4(aPos, 1.0);
      vNormal = mat3(uModel) * aNormal;
      vWorldPos = (uModel * vec4(aPos, 1.0)).xyz;
    }
  `;

  const FS_SOURCE = `
    precision mediump float;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    uniform vec3 uColor;
    uniform vec3 uLightDir;
    void main() {
      vec3 n = normalize(vNormal);
      vec3 l = normalize(uLightDir);
      float diff = max(dot(n, l), 0.0);
      float ambient = 0.35;
      float light = ambient + diff * 0.65;
      vec3 col = uColor * light;
      vec3 v = normalize(-vWorldPos);
      vec3 h = normalize(l + v);
      float spec = pow(max(dot(n, h), 0.0), 32.0) * 0.3;
      col += vec3(spec);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const FS_FLAT = `
    precision mediump float;
    uniform vec3 uColor;
    void main() {
      gl_FragColor = vec4(uColor, 1.0);
    }
  `;

  let shaderLit = null;
  let shaderFlat = null;

  function compileShader(src, type) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  }

  function createProgram(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compileShader(vs, gl.VERTEX_SHADER));
    gl.attachShader(p, compileShader(fs, gl.FRAGMENT_SHADER));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  function initShaders() {
    shaderLit = createProgram(VS_SOURCE, FS_SOURCE);
    shaderFlat = createProgram(VS_SOURCE, FS_FLAT);
    if (!shaderLit || !shaderFlat) {
      console.error('Failed to compile shaders');
      return false;
    }
    return true;
  }

  // --- Math helpers ---
  function mat4Perspective(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return [
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0
    ];
  }

  function mat4LookAt(eye, center, up) {
    const zx = eye[0]-center[0], zy = eye[1]-center[1], zz = eye[2]-center[2];
    let len = Math.sqrt(zx*zx + zy*zy + zz*zz);
    const z0 = zx/len, z1 = zy/len, z2 = zz/len;
    const xx = up[1]*z2 - up[2]*z1;
    const xy = up[2]*z0 - up[0]*z2;
    const xz = up[0]*z1 - up[1]*z0;
    len = Math.sqrt(xx*xx + xy*xy + xz*xz);
    const x0 = xx/len, x1 = xy/len, x2 = xz/len;
    const y0 = z1*x2 - z2*x1;
    const y1 = z2*x0 - z0*x2;
    const y2 = z0*x1 - z1*x0;
    return [
      x0, y0, z0, 0,
      x1, y1, z1, 0,
      x2, y2, z2, 0,
      -(x0*eye[0]+x1*eye[1]+x2*eye[2]),
      -(y0*eye[0]+y1*eye[1]+y2*eye[2]),
      -(z0*eye[0]+z1*eye[1]+z2*eye[2]),
      1
    ];
  }

  function mat4Mul(a, b) {
    const o = new Float32Array(16);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        o[j*4+i] = a[i]*b[j*4] + a[4+i]*b[j*4+1] + a[8+i]*b[j*4+2] + a[12+i]*b[j*4+3];
      }
    return o;
  }

  function mat4Translate(x, y, z) {
    return [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
  }

  function mat4Scale(sx, sy, sz) {
    return [sx,0,0,0, 0,sy,0,0, 0,0,sz,0, 0,0,0,1];
  }

  function mat4RotateY(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1];
  }

  function mat4RotateX(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return [1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1];
  }

  function mat4Identity() {
    return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  }

  // --- Geometry: box ---
  function generateBox(sx, sy, sz) {
    const hw = sx/2, hh = sy/2, hd = sz/2;
    const verts = [
      -hw,-hh, hd,  hw,-hh, hd,  hw, hh, hd, -hw, hh, hd,
       hw,-hh,-hd, -hw,-hh,-hd, -hw, hh,-hd,  hw, hh,-hd,
      -hw,-hh,-hd, -hw,-hh, hd, -hw, hh, hd, -hw, hh,-hd,
       hw,-hh, hd,  hw,-hh,-hd,  hw, hh,-hd,  hw, hh, hd,
      -hw, hh, hd,  hw, hh, hd,  hw, hh,-hd, -hw, hh,-hd,
      -hw,-hh,-hd,  hw,-hh,-hd,  hw,-hh, hd, -hw,-hh, hd,
    ];
    const norms = [
      0,0,1, 0,0,1, 0,0,1, 0,0,1,
      0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,
      -1,0,0, -1,0,0, -1,0,0, -1,0,0,
      1,0,0, 1,0,0, 1,0,0, 1,0,0,
      0,1,0, 0,1,0, 0,1,0, 0,1,0,
      0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,
    ];
    const idx = [];
    for (let i = 0; i < 6; i++) {
      const o = i * 4;
      idx.push(o,o+1,o+2, o,o+2,o+3);
    }
    return { verts, norms, idx };
  }

  function mergeGeos(geos) {
    const allV = [], allN = [], allI = [];
    let vOff = 0;
    for (const g of geos) {
      for (let i = 0; i < g.verts.length; i++) allV.push(g.verts[i]);
      for (let i = 0; i < g.norms.length; i++) allN.push(g.norms[i]);
      for (let i = 0; i < g.idx.length; i++) allI.push(g.idx[i] + vOff);
      vOff += g.verts.length / 3;
    }
    return { verts: allV, norms: allN, idx: allI };
  }

  function genCylinder(radius, height, segs) {
    const verts = [], norms = [], idx = [];
    const hh = height / 2;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
      const nx = Math.cos(a), nz = Math.sin(a);
      verts.push(x, -hh, z, x, hh, z);
      norms.push(nx, 0, nz, nx, 0, nz);
    }
    for (let i = 0; i < segs; i++) {
      const o = i * 2;
      idx.push(o, o+1, o+3, o, o+3, o+2);
    }
    return { verts, norms, idx };
  }

  function genTorus(majorR, minorR, majorSegs, minorSegs) {
    const verts = [], norms = [], idx = [];
    for (let i = 0; i <= majorSegs; i++) {
      const u = (i / majorSegs) * Math.PI * 2;
      const cu = Math.cos(u), su = Math.sin(u);
      for (let j = 0; j <= minorSegs; j++) {
        const v = (j / minorSegs) * Math.PI * 2;
        const cv = Math.cos(v), sv = Math.sin(v);
        const x = (majorR + minorR * cv) * cu;
        const y = minorR * sv;
        const z = (majorR + minorR * cv) * su;
        verts.push(x, y, z);
        const nx = cv * cu, ny = sv, nz = cv * su;
        norms.push(nx, ny, nz);
      }
    }
    for (let i = 0; i < majorSegs; i++) {
      for (let j = 0; j < minorSegs; j++) {
        const a = i * (minorSegs + 1) + j;
        const b = a + minorSegs + 1;
        idx.push(a, b, a+1, b, b+1, a+1);
      }
    }
    return { verts, norms, idx };
  }

  function genRing(innerR, outerR, height, segs) {
    const verts = [], norms = [], idx = [];
    const hh = height / 2;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      verts.push(c * innerR, -hh, s * innerR);
      verts.push(c * outerR, -hh, s * outerR);
      verts.push(c * innerR, hh, s * innerR);
      verts.push(c * outerR, hh, s * outerR);
      norms.push(0,-1,0, 0,-1,0, 0,1,0, 0,1,0);
    }
    for (let i = 0; i < segs; i++) {
      const o = i * 4;
      idx.push(o, o+4, o+1, o+1, o+4, o+5);
      idx.push(o+2, o+3, o+6, o+3, o+7, o+6);
    }
    return { verts, norms, idx };
  }

  // --- Build avatar mesh ---
  function buildAvatarGeometry() {
    const parts = [];

    // Head (slightly oversized)
    const head = generateBox(1.1, 1.1, 1.1);
    const headT = mat4Translate(0, 1.55, 0);
    parts.push({ geo: head, transform: headT, color: currentBodyColor, isHead: true });

    // Torso
    const torso = generateBox(1.0, 1.1, 0.65);
    const torsoT = mat4Translate(0, 0.5, 0);
    parts.push({ geo: torso, transform: torsoT, color: currentBodyColor });

    // Left arm
    const laGeo = generateBox(0.4, 1.0, 0.4);
    const laT = mat4Translate(-0.7, 0.55, 0);
    parts.push({ geo: laGeo, transform: laT, color: currentBodyColor });

    // Right arm
    const raGeo = generateBox(0.4, 1.0, 0.4);
    const raT = mat4Translate(0.7, 0.55, 0);
    parts.push({ geo: raGeo, transform: raT, color: currentBodyColor });

    // Left leg
    const llGeo = generateBox(0.45, 0.85, 0.5);
    const llT = mat4Translate(-0.25, -0.55, 0);
    parts.push({ geo: llGeo, transform: llT, color: currentBodyColor });

    // Right leg
    const rlGeo = generateBox(0.45, 0.85, 0.5);
    const rlT = mat4Translate(0.25, -0.55, 0);
    parts.push({ geo: rlGeo, transform: rlT, color: currentBodyColor });

    // Face features (on head front)
    // Eyes
    const eyeL = generateBox(0.18, 0.18, 0.05);
    const eyeLT = mat4Translate(-0.22, 1.65, 0.56);
    parts.push({ geo: eyeL, transform: eyeLT, color: [1,1,1], flat: true });

    const eyeR = generateBox(0.18, 0.18, 0.05);
    const eyeRT = mat4Translate(0.22, 1.65, 0.56);
    parts.push({ geo: eyeR, transform: eyeRT, color: [1,1,1], flat: true });

    // Pupils
    const pupL = generateBox(0.1, 0.1, 0.02);
    const pupLT = mat4Translate(-0.22, 1.65, 0.58);
    parts.push({ geo: pupL, transform: pupLT, color: [0.12,0.12,0.12], flat: true });

    const pupR = generateBox(0.1, 0.1, 0.02);
    const pupRT = mat4Translate(0.22, 1.65, 0.58);
    parts.push({ geo: pupR, transform: pupRT, color: [0.12,0.12,0.12], flat: true });

    // Mouth
    if (currentFace === 'smile' || currentFace === 'wink') {
      const mouth = generateBox(0.3, 0.06, 0.02);
      const mouthT = mat4Translate(0, 1.43, 0.56);
      parts.push({ geo: mouth, transform: mouthT, color: [0.12,0.12,0.12], flat: true });
    } else if (currentFace === 'cool') {
      // Sunglasses
      const glassL = generateBox(0.22, 0.15, 0.06);
      const glassLT = mat4Translate(-0.22, 1.65, 0.56);
      parts.push({ geo: glassL, transform: glassLT, color: [0.1,0.1,0.1], flat: true });
      const glassR = generateBox(0.22, 0.15, 0.06);
      const glassRT = mat4Translate(0.22, 1.65, 0.56);
      parts.push({ geo: glassR, transform: glassRT, color: [0.1,0.1,0.1], flat: true });
      const bridge = generateBox(0.1, 0.04, 0.06);
      const bridgeT = mat4Translate(0, 1.68, 0.56);
      parts.push({ geo: bridge, transform: bridgeT, color: [0.1,0.1,0.1], flat: true });
    } else if (currentFace === 'laugh') {
      const mouth = generateBox(0.25, 0.12, 0.02);
      const mouthT = mat4Translate(0, 1.42, 0.56);
      parts.push({ geo: mouth, transform: mouthT, color: [0.8,0.2,0.2], flat: true });
    } else if (currentFace === 'angry') {
      // Angry eyebrows
      const browL = generateBox(0.2, 0.05, 0.03);
      const browLT = mat4Translate(-0.22, 1.78, 0.57);
      parts.push({ geo: browL, transform: mat4Mul(mat4Translate(-0.22, 1.78, 0.57), mat4RotateZ(0.3)), color: [0.12,0.12,0.12], flat: true });
      parts.push({ geo: browL, transform: mat4Mul(mat4Translate(0.22, 1.78, 0.57), mat4RotateZ(-0.3)), color: [0.12,0.12,0.12], flat: true });
      const mouth = generateBox(0.18, 0.04, 0.02);
      parts.push({ geo: mouth, transform: mat4Translate(0, 1.42, 0.56), color: [0.12,0.12,0.12], flat: true });
    } else if (currentFace === 'star') {
      // Simple star: two crossed boxes
      const starC = generateBox(0.2, 0.2, 0.02);
      const starT = mat4Translate(0, 1.52, 0.57);
      parts.push({ geo: starC, transform: starT, color: [1,0.85,0.24], flat: true });
      const starH = generateBox(0.35, 0.1, 0.02);
      parts.push({ geo: starH, transform: starT, color: [1,0.85,0.24], flat: true });
      const starV = generateBox(0.1, 0.35, 0.02);
      parts.push({ geo: starV, transform: starT, color: [1,0.85,0.24], flat: true });
    }

    // Hat
    if (currentHat === 'crown') {
      const base = generateBox(0.9, 0.18, 0.9);
      parts.push({ geo: base, transform: mat4Translate(0, 2.25, 0), color: [1,0.85,0.24] });
      for (let i = -1; i <= 1; i++) {
        const spike = generateBox(0.18, 0.25, 0.18);
        parts.push({ geo: spike, transform: mat4Translate(i * 0.3, 2.45, 0), color: [1,0.85,0.24] });
      }
    } else if (currentHat === 'cap') {
      const brim = generateBox(1.1, 0.1, 0.8);
      parts.push({ geo: brim, transform: mat4Translate(0, 2.15, 0.1), color: [0.9,0.25,0.2] });
      const top = generateBox(0.85, 0.25, 0.85);
      parts.push({ geo: top, transform: mat4Translate(0, 2.25, 0), color: [0.9,0.25,0.2] });
    } else if (currentHat === 'tophat') {
      const brim = generateBox(1.1, 0.12, 1.1);
      parts.push({ geo: brim, transform: mat4Translate(0, 2.15, 0), color: [0.15,0.15,0.15] });
      const tall = generateBox(0.7, 0.6, 0.7);
      parts.push({ geo: tall, transform: mat4Translate(0, 2.5, 0), color: [0.15,0.15,0.15] });
      const band = generateBox(0.72, 0.08, 0.72);
      parts.push({ geo: band, transform: mat4Translate(0, 2.25, 0), color: [0.9,0.25,0.2] });
    } else if (currentHat === 'headphones') {
      const band = generateBox(1.1, 0.1, 0.15);
      parts.push({ geo: band, transform: mat4Translate(0, 2.2, 0), color: [0.15,0.15,0.15] });
      const earL = generateBox(0.25, 0.3, 0.25);
      parts.push({ geo: earL, transform: mat4Translate(-0.55, 1.9, 0), color: [0.15,0.15,0.15] });
      const earR = generateBox(0.25, 0.3, 0.25);
      parts.push({ geo: earR, transform: mat4Translate(0.55, 1.9, 0), color: [0.15,0.15,0.15] });
      const padL = generateBox(0.15, 0.18, 0.15);
      parts.push({ geo: padL, transform: mat4Translate(-0.55, 1.9, 0.13), color: [0.1,0.55,0.95] });
      const padR = generateBox(0.15, 0.18, 0.15);
      parts.push({ geo: padR, transform: mat4Translate(0.55, 1.9, 0.13), color: [0.1,0.55,0.95] });
    } else if (currentHat === 'halo') {
      const halo = genTorus(0.5, 0.05, 24, 8);
      parts.push({ geo: halo, transform: mat4Translate(0, 2.3, 0), color: [1,0.85,0.24], flat: true });
    }

    // Accessories
    if (currentAccessory === 'sword') {
      const blade = generateBox(0.08, 0.9, 0.04);
      parts.push({ geo: blade, transform: mat4Translate(0.85, 0.3, 0), color: [0.75,0.75,0.75] });
      const guard = generateBox(0.25, 0.06, 0.06);
      parts.push({ geo: guard, transform: mat4Translate(0.85, -0.15, 0), color: [0.75,0.75,0.75] });
      const handle = generateBox(0.08, 0.2, 0.08);
      parts.push({ geo: handle, transform: mat4Translate(0.85, -0.3, 0), color: [0.55,0.3,0.07] });
      const gem = generateBox(0.06, 0.06, 0.06);
      parts.push({ geo: gem, transform: mat4Translate(0.85, -0.38, 0), color: [1,0.85,0.24] });
    } else if (currentAccessory === 'shield') {
      const body = generateBox(0.6, 0.7, 0.08);
      parts.push({ geo: body, transform: mat4Translate(-0.85, 0.4, 0), color: [0.13,0.59,0.95] });
      const emblem = generateBox(0.2, 0.2, 0.04);
      parts.push({ geo: emblem, transform: mat4Translate(-0.85, 0.4, 0.06), color: [1,0.85,0.24] });
    } else if (currentAccessory === 'wings') {
      const wingL = generateBox(0.6, 0.4, 0.08);
      parts.push({ geo: wingL, transform: mat4Translate(-0.6, 0.85, -0.35), color: [0.95,0.95,0.95] });
      const wingR = generateBox(0.6, 0.4, 0.08);
      parts.push({ geo: wingR, transform: mat4Translate(0.6, 0.85, -0.35), color: [0.95,0.95,0.95] });
    } else if (currentAccessory === 'cape') {
      const cape = generateBox(0.85, 1.2, 0.06);
      parts.push({ geo: cape, transform: mat4Translate(0, 0.15, -0.38), color: [0.61,0.35,0.71] });
    } else if (currentAccessory === 'backpack') {
      const pack = generateBox(0.5, 0.55, 0.3);
      parts.push({ geo: pack, transform: mat4Translate(0, 0.55, -0.48), color: [0.9,0.49,0.14] });
      const strap = generateBox(0.08, 0.5, 0.06);
      parts.push({ geo: strap, transform: mat4Translate(-0.2, 0.55, -0.28), color: [0.83,0.33,0] });
      const strap2 = generateBox(0.08, 0.5, 0.06);
      parts.push({ geo: strap2, transform: mat4Translate(0.2, 0.55, -0.28), color: [0.83,0.33,0] });
    }

    return parts;
  }

  function hexToGL(hex) {
    const r = parseInt(hex.slice(1,3), 16) / 255;
    const g = parseInt(hex.slice(3,5), 16) / 255;
    const b = parseInt(hex.slice(5,7), 16) / 255;
    return [r, g, b];
  }

  // --- Draw a single mesh part ---
  function drawPart(modelMat, color, isLit) {
    const prog = isLit ? shaderLit : shaderFlat;
    gl.useProgram(prog);

    const mvp = mat4Mul(projMat, mat4Mul(viewMat, modelMat));

    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, mvp);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uModel'), false, modelMat);

    const colLoc = gl.getUniformLocation(prog, 'uColor');
    gl.uniform3f(colLoc, color[0], color[1], color[2]);

    if (isLit) {
      const lightDir = [0.4, 0.7, 0.5];
      gl.uniform3f(gl.getUniformLocation(prog, 'uLightDir'), lightDir[0], lightDir[1], lightDir[2]);
    }

    const posLoc = gl.getAttribLocation(prog, 'aPos');
    const normLoc = gl.getAttribLocation(prog, 'aNormal');

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.enableVertexAttribArray(normLoc);
    gl.vertexAttribPointer(normLoc, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.drawElements(gl.TRIANGLES, totalIndices, gl.UNSIGNED_SHORT, 0);
  }

  function drawLinePart(modelMat, color) {
    const prog = shaderFlat;
    gl.useProgram(prog);

    const mvp = mat4Mul(projMat, mat4Mul(viewMat, modelMat));
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, mvp);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uModel'), false, modelMat);
    gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), color[0], color[1], color[2]);

    const posLoc = gl.getAttribLocation(prog, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIndexBuffer);
    gl.drawElements(gl.LINES, totalLineIndices, gl.UNSIGNED_SHORT, 0);
  }

  let projMat, viewMat;

  function render() {
    if (!gl || !canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth * dpr;
    const h = canvas.clientHeight * dpr;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.14, 0.14, 0.18, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    projMat = mat4Perspective(Math.PI / 5, canvas.width / canvas.height, 0.1, 100);
    viewMat = mat4LookAt([0, 1.2, 5.5], [0, 0.6, 0], [0, 1, 0]);

    const parts = buildAvatarGeometry();

    // Draw all lit body parts
    for (const part of parts) {
      const modelMat = mat4Mul(
        mat4Mul(mat4Translate(0, -0.4, 0), mat4Mul(mat4RotateY(rotY), mat4RotateX(rotX))),
        part.transform
      );
      drawPart(modelMat, part.color, !part.flat);
    }

    // Ground shadow
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    const shadowMat = mat4Mul(
      mat4Mul(mat4Translate(0, -0.98, 0), mat4Mul(mat4RotateY(rotY), mat4RotateX(rotX))),
      mat4Scale(1.2, 0.02, 1.2)
    );
    drawPart(shadowMat, [0.08, 0.08, 0.1], false);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);

    if (autoRotate && !dragging) {
      rotY += 0.008;
    }
    animFrame = requestAnimationFrame(render);
  }

  function onMouseDown(e) {
    dragging = true;
    lastMX = e.clientX;
    lastMY = e.clientY;
    canvas.style.cursor = 'grabbing';
  }

  function onMouseMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastMX;
    const dy = e.clientY - lastMY;
    rotY += dx * 0.01;
    rotX += dy * 0.01;
    rotX = Math.max(-1.2, Math.min(0.5, rotX));
    lastMX = e.clientX;
    lastMY = e.clientY;
  }

  function onMouseUp() {
    dragging = false;
    canvas.style.cursor = 'grab';
  }

  function onTouchStart(e) {
    if (e.touches.length === 1) {
      dragging = true;
      lastMX = e.touches[0].clientX;
      lastMY = e.touches[0].clientY;
    }
  }

  function onTouchMove(e) {
    if (!dragging || e.touches.length !== 1) return;
    e.preventDefault();
    const dx = e.touches[0].clientX - lastMX;
    const dy = e.touches[0].clientY - lastMY;
    rotY += dx * 0.01;
    rotX += dy * 0.01;
    rotX = Math.max(-1.2, Math.min(0.5, rotX));
    lastMX = e.touches[0].clientX;
    lastMY = e.touches[0].clientY;
  }

  function onTouchEnd() {
    dragging = false;
  }

  function initCanvas(id) {
    canvas = document.getElementById(id);
    if (!canvas) return false;

    gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) {
      console.error('WebGL not available');
      return false;
    }

    if (!initShaders()) return false;

    // Pre-generate a unit box for reuse
    const unitBox = generateBox(1, 1, 1);
    posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(unitBox.verts), gl.STATIC_DRAW);

    normalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(unitBox.norms), gl.STATIC_DRAW);

    indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(unitBox.idx), gl.STATIC_DRAW);
    totalIndices = unitBox.idx.length;

    // Line indices (wireframe box edges)
    const edges = [
      0,1, 1,2, 2,3, 3,0,
      4,5, 5,6, 6,7, 7,4,
      0,4, 1,5, 2,6, 3,7
    ];
    lineIndexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(edges), gl.STATIC_DRAW);
    totalLineIndices = edges.length;

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseUp);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);

    return true;
  }

  function stop() {
    if (animFrame) cancelAnimationFrame(animFrame);
    animFrame = null;
  }

  window.render3DAvatar = function(avatarData) {
    if (!avatarData) return;

    if (avatarData.bodyColor) currentBodyColor = hexToGL(avatarData.bodyColor);
    if (avatarData.face) currentFace = avatarData.face;
    if (avatarData.hat !== undefined) currentHat = avatarData.hat;
    if (avatarData.accessory !== undefined) currentAccessory = avatarData.accessory;

    if (!canvas || !gl) {
      if (!initCanvas('avatar-3d')) return;
    }

    stop();
    render();
  };

  window.addEventListener('DOMContentLoaded', function() {
    const c = document.getElementById('avatar-3d');
    if (c) {
      initCanvas('avatar-3d');
      render();
    }
  });

})();
