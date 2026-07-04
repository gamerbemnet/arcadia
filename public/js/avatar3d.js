// Arcadia 3D Avatar Renderer - Loads GLB model + procedural accessories
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
  let currentHair = 'none';
  let currentShirt = 'none';
  let currentPants = 'none';

  // GLB model data
  let glbModel = null;
  let glbTexture = null;
  let modelReady = false;

  const VS_SOURCE = `
    attribute vec3 aPos;
    attribute vec3 aNormal;
    uniform mat4 uMVP;
    uniform mat4 uModel;
    varying vec3 vNormal;
    varying vec3 vPos;
    void main() {
      gl_Position = uMVP * vec4(aPos, 1.0);
      vNormal = mat3(uModel) * aNormal;
      vPos = aPos;
    }
  `;

  const FS_SOURCE = `
    precision mediump float;
    varying vec3 vNormal;
    varying vec3 vPos;
    uniform vec3 uColor;
    uniform vec3 uLightDir;
    uniform float uUseTexture;
    uniform sampler2D uTexture;
    uniform vec2 uTexScale;
    uniform vec2 uTexOffset;
    void main() {
      vec3 n = normalize(vNormal);
      vec3 l = normalize(uLightDir);
      float d = dot(n, l);
      float shade;
      if (d > 0.45) shade = 1.0;
      else if (d > -0.1) shade = 0.78;
      else shade = 0.58;
      vec3 baseColor = uColor;
      if (uUseTexture > 0.5) {
        baseColor = texture2D(uTexture, vPos.xy * uTexScale + uTexOffset).rgb;
      }
      gl_FragColor = vec4(baseColor * shade, 1.0);
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
    return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0];
  }

  function mat4LookAt(eye, center, up) {
    const zx=eye[0]-center[0], zy=eye[1]-center[1], zz=eye[2]-center[2];
    let len=Math.sqrt(zx*zx+zy*zy+zz*zz);
    const z0=zx/len, z1=zy/len, z2=zz/len;
    const xx=up[1]*z2-up[2]*z1, xy=up[2]*z0-up[0]*z2, xz=up[0]*z1-up[1]*z0;
    len=Math.sqrt(xx*xx+xy*xy+xz*xz);
    const x0=xx/len, x1=xy/len, x2=xz/len;
    const y0=z1*x2-z2*x1, y1=z2*x0-z0*x2, y2=z0*x1-z1*x0;
    return [x0,y0,z0,0, x1,y1,z1,0, x2,y2,z2,0,
      -(x0*eye[0]+x1*eye[1]+x2*eye[2]),
      -(y0*eye[0]+y1*eye[1]+y2*eye[2]),
      -(z0*eye[0]+z1*eye[1]+z2*eye[2]),1];
  }

  function mat4Mul(a, b) {
    const o = new Float32Array(16);
    for (let i=0;i<4;i++) for (let j=0;j<4;j++)
      o[j*4+i]=a[i]*b[j*4]+a[4+i]*b[j*4+1]+a[8+i]*b[j*4+2]+a[12+i]*b[j*4+3];
    return o;
  }

  function mat4Translate(x,y,z) { return [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]; }
  function mat4Scale(sx,sy,sz) { return [sx,0,0,0, 0,sy,0,0, 0,0,sz,0, 0,0,0,1]; }
  function mat4RotateY(a) { const c=Math.cos(a),s=Math.sin(a); return [c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]; }
  function mat4RotateX(a) { const c=Math.cos(a),s=Math.sin(a); return [1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1]; }
  function mat4RotateZ(a) { const c=Math.cos(a),s=Math.sin(a); return [c,-s,0,0, s,c,0,0, 0,0,1,0, 0,0,0,1]; }
  function mat4Identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }

  // --- GLB Loader ---
  async function loadGLB(url) {
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    const view = new DataView(buf);

    // Header
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546C67) { console.error('Not a GLB file'); return null; }
    const version = view.getUint32(4, true);
    const totalLength = view.getUint32(8, true);

    let jsonChunk = null;
    let binChunk = null;
    let offset = 12;

    while (offset < totalLength) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      offset += 8;
      if (chunkType === 0x4E4F534A) {
        const bytes = new Uint8Array(buf, offset, chunkLength);
        jsonChunk = JSON.parse(new TextDecoder().decode(bytes));
      } else if (chunkType === 0x004E4942) {
        binChunk = new Uint8Array(buf, offset, chunkLength);
      }
      offset += chunkLength;
    }

    if (!jsonChunk || !binChunk) return null;
    return parseGLTF(jsonChunk, binChunk);
  }

  function parseGLTF(json, bin) {
    const meshes = [];
    const bufferViews = json.bufferViews || [];
    const accessors = json.accessors || [];
    const images = json.images || [];
    const textures = json.textures || [];
    const materials = json.materials || [];
    const nodes = json.nodes || [];
    const scenes = json.scenes || [{}];

    function getAccessorData(accessorIdx, componentType) {
      const acc = accessors[accessorIdx];
      const bv = bufferViews[acc.bufferView];
      const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const count = acc.count * (acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : acc.type === 'SCALAR' ? 1 : 4);
      let TypedArray;
      switch (componentType || acc.componentType) {
        case 5126: TypedArray = Float32Array; break;
        case 5123: TypedArray = Uint16Array; break;
        case 5125: TypedArray = Uint32Array; break;
        default: TypedArray = Float32Array;
      }
      if (TypedArray === Uint16Array || TypedArray === Uint32Array) {
        return new TypedArray(bin.buffer, bin.byteOffset + offset, count);
      }
      return new TypedArray(bin.buffer, bin.byteOffset + offset, count);
    }

    function getMaterialColor(matIdx) {
      if (matIdx === undefined || !materials[matIdx]) return [1,1,1];
      const pbr = materials[matIdx].pbrMetallicRoughness;
      if (!pbr) return [1,1,1];
      const c = pbr.baseColorFactor || [1,1,1,1];
      return [c[0], c[1], c[2]];
    }

    function getMaterialTexture(matIdx) {
      if (matIdx === undefined || !materials[matIdx]) return null;
      const pbr = materials[matIdx].pbrMetallicRoughness;
      if (!pbr || !pbr.baseColorTexture) return null;
      const texIdx = pbr.baseColorTexture.index;
      const tex = textures[texIdx];
      if (!tex) return null;
      const imgIdx = tex.source;
      const img = images[imgIdx];
      if (!img) return null;
      return img.uri || img.bufferView;
    }

    const rootNodes = scenes[0].nodes || [];

    function processNode(nodeIdx, parentTransform) {
      const node = nodes[nodeIdx];
      let localTransform = mat4Identity();

      if (node.matrix) localTransform = new Float32Array(node.matrix);
      if (node.translation) {
        const t = node.translation;
        localTransform = mat4Mul(localTransform, mat4Translate(t[0], t[1], t[2]));
      }
      if (node.rotation) {
        const q = node.rotation;
        const tx=2*q[0], ty=2*q[1], tz=2*q[2];
        const tw=2*q[3];
        localTransform = mat4Mul(localTransform, [
          1-ty*ty-tz*tz, tx*ty+tw*tz, tx*tz-tw*ty, 0,
          tx*ty-tw*tz, 1-tx*tx-tz*tz, ty*tz+tw*tx, 0,
          tx*tz+tw*ty, ty*tz-tw*tx, 1-tx*tx-ty*ty, 0,
          0,0,0,1
        ]);
      }
      if (node.scale) {
        const s = node.scale;
        localTransform = mat4Mul(localTransform, mat4Scale(s[0], s[1], s[2]));
      }

      const worldTransform = mat4Mul(parentTransform, localTransform);

      if (node.mesh !== undefined) {
        const mesh = json.meshes[node.mesh];
        for (const primitive of mesh.primitives) {
          const positions = getAccessorData(primitive.attributes.POSITION);
          const normals = primitive.attributes.NORMAL !== undefined ? getAccessorData(primitive.attributes.NORMAL) : null;
          const indices = primitive.indices !== undefined ? getAccessorData(primitive.indices) : null;
          const color = getMaterialColor(primitive.material);

          // Compute bounds for texture scaling
          let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
          for (let i=0;i<positions.length;i+=3) {
            minX=Math.min(minX,positions[i]); maxX=Math.max(maxX,positions[i]);
            minY=Math.min(minY,positions[i+1]); maxY=Math.max(maxY,positions[i+1]);
          }

          meshes.push({
            positions: new Float32Array(positions),
            normals: normals ? new Float32Array(normals) : null,
            indices: indices ? new Uint16Array(indices) : null,
            color,
            transform: worldTransform
          });
        }
      }

      if (node.children) {
        for (const child of node.children) processNode(child, worldTransform);
      }
    }

    for (const nodeIdx of rootNodes) processNode(nodeIdx, mat4Identity());

    return { meshes };
  }

  // --- Unit box for accessories ---
  function generateBox(sx,sy,sz) {
    const hw=sx/2,hh=sy/2,hd=sz/2;
    return { verts: [
      -hw,-hh,hd, hw,-hh,hd, hw,hh,hd, -hw,hh,hd,
      hw,-hh,-hd, -hw,-hh,-hd, -hw,hh,-hd, hw,hh,-hd,
      -hw,-hh,-hd, -hw,-hh,hd, -hw,hh,hd, -hw,hh,-hd,
      hw,-hh,hd, hw,-hh,-hd, hw,hh,-hd, hw,hh,hd,
      -hw,hh,hd, hw,hh,hd, hw,hh,-hd, -hw,hh,-hd,
      -hw,-hh,-hd, hw,-hh,-hd, hw,-hh,hd, -hw,-hh,hd
    ], norms: [
      0,0,1,0,0,1,0,0,1,0,0,1,
      0,0,-1,0,0,-1,0,0,-1,0,0,-1,
      -1,0,0,-1,0,0,-1,0,0,-1,0,0,
      1,0,0,1,0,0,1,0,0,1,0,0,
      0,1,0,0,1,0,0,1,0,0,1,0,
      0,-1,0,0,-1,0,0,-1,0,0,-1,0
    ], idx: (() => { const idx=[]; for(let i=0;i<6;i++){const o=i*4;idx.push(o,o+1,o+2,o,o+2,o+3);} return idx; })() };
  }

  // --- Build procedural accessories on top of GLB ---
  function buildAccessoryGeometry() {
    const parts = [];
    const fz = 0.67;

    // Face features
    if (currentFace === 'smile') {
      parts.push({ scale:[0.35,0.08,0.04], transform:mat4Translate(0,1.55,fz), color:[0.1,0.1,0.1], flat:true });
    } else if (currentFace === 'cool') {
      parts.push({ scale:[0.32,0.18,0.06], transform:mat4Translate(-0.25,1.8,fz), color:[0.1,0.1,0.1], flat:true });
      parts.push({ scale:[0.32,0.18,0.06], transform:mat4Translate(0.25,1.8,fz), color:[0.1,0.1,0.1], flat:true });
      parts.push({ scale:[0.12,0.06,0.06], transform:mat4Translate(0,1.84,fz), color:[0.1,0.1,0.1], flat:true });
    } else if (currentFace === 'laugh') {
      parts.push({ scale:[0.3,0.15,0.04], transform:mat4Translate(0,1.52,fz), color:[0.1,0.1,0.1], flat:true });
      parts.push({ scale:[0.2,0.06,0.04], transform:mat4Translate(0,1.58,fz), color:[1,1,1], flat:true });
    } else if (currentFace === 'angry') {
      parts.push({ scale:[0.25,0.06,0.04], transform:mat4Mul(mat4Translate(-0.25,1.98,fz),mat4RotateZ(0.35)), color:[0.1,0.1,0.1], flat:true });
      parts.push({ scale:[0.25,0.06,0.04], transform:mat4Mul(mat4Translate(0.25,1.98,fz),mat4RotateZ(-0.35)), color:[0.1,0.1,0.1], flat:true });
      parts.push({ scale:[0.2,0.05,0.04], transform:mat4Translate(0,1.52,fz), color:[0.1,0.1,0.1], flat:true });
    } else if (currentFace === 'star') {
      parts.push({ scale:[0.25,0.25,0.04], transform:mat4Translate(0,1.72,fz), color:[1,0.85,0.2], flat:true });
      parts.push({ scale:[0.4,0.12,0.04], transform:mat4Translate(0,1.72,fz), color:[1,0.85,0.2], flat:true });
      parts.push({ scale:[0.12,0.4,0.04], transform:mat4Translate(0,1.72,fz), color:[1,0.85,0.2], flat:true });
    } else if (currentFace === 'wink') {
      parts.push({ scale:[0.28,0.06,0.04], transform:mat4Translate(-0.25,1.8,fz), color:[0.1,0.1,0.1], flat:true });
      parts.push({ scale:[0.35,0.08,0.04], transform:mat4Translate(0,1.55,fz), color:[0.1,0.1,0.1], flat:true });
    }

    // Hat
    if (currentHat === 'crown') {
      parts.push({ scale:[1.0,0.2,1.0], transform:mat4Translate(0,2.45,0), color:[1,0.85,0.2] });
      parts.push({ scale:[0.2,0.3,0.2], transform:mat4Translate(-0.3,2.7,0), color:[1,0.85,0.2] });
      parts.push({ scale:[0.2,0.3,0.2], transform:mat4Translate(0,2.7,0), color:[1,0.85,0.2] });
      parts.push({ scale:[0.2,0.3,0.2], transform:mat4Translate(0.3,2.7,0), color:[1,0.85,0.2] });
    } else if (currentHat === 'cap') {
      parts.push({ scale:[1.2,0.1,0.9], transform:mat4Translate(0,2.35,0.15), color:[0.9,0.25,0.2] });
      parts.push({ scale:[1.0,0.3,1.0], transform:mat4Translate(0,2.5,0), color:[0.9,0.25,0.2] });
    } else if (currentHat === 'tophat') {
      parts.push({ scale:[1.2,0.12,1.2], transform:mat4Translate(0,2.35,0), color:[0.12,0.12,0.12] });
      parts.push({ scale:[0.8,0.7,0.8], transform:mat4Translate(0,2.75,0), color:[0.12,0.12,0.12] });
      parts.push({ scale:[0.82,0.1,0.82], transform:mat4Translate(0,2.45,0), color:[0.9,0.25,0.2] });
    } else if (currentHat === 'headphones') {
      parts.push({ scale:[1.3,0.12,0.15], transform:mat4Translate(0,2.4,0), color:[0.12,0.12,0.12] });
      parts.push({ scale:[0.28,0.35,0.28], transform:mat4Translate(-0.65,2.05,0), color:[0.12,0.12,0.12] });
      parts.push({ scale:[0.28,0.35,0.28], transform:mat4Translate(0.65,2.05,0), color:[0.12,0.12,0.12] });
      parts.push({ scale:[0.18,0.22,0.18], transform:mat4Translate(-0.65,2.05,0.15), color:[0.1,0.55,0.95] });
      parts.push({ scale:[0.18,0.22,0.18], transform:mat4Translate(0.65,2.05,0.15), color:[0.1,0.55,0.95] });
    } else if (currentHat === 'halo') {
      parts.push({ scale:[1.1,0.08,1.1], transform:mat4Translate(0,2.55,0), color:[1,0.85,0.2] });
      parts.push({ scale:[0.9,0.12,0.9], transform:mat4Translate(0,2.55,0), color:[0.12,0.12,0.12] });
    }

    // Hair
    const hairColor = [0.3,0.2,0.1];
    if (currentHair === 'spiky') {
      parts.push({ scale:[0.15,0.4,0.15], transform:mat4Translate(-0.2,2.45,0.1), color:hairColor });
      parts.push({ scale:[0.15,0.45,0.15], transform:mat4Translate(0,2.5,0), color:hairColor });
      parts.push({ scale:[0.15,0.4,0.15], transform:mat4Translate(0.2,2.45,0.1), color:hairColor });
    } else if (currentHair === 'mohawk') {
      parts.push({ scale:[0.12,0.5,0.5], transform:mat4Translate(0,2.55,0), color:[0.8,0.2,0.1] });
    } else if (currentHair === 'afro') {
      parts.push({ scale:[1.3,0.7,1.3], transform:mat4Translate(0,2.5,0), color:hairColor });
    } else if (currentHair === 'bun') {
      parts.push({ scale:[0.35,0.35,0.35], transform:mat4Translate(0,2.6,-0.15), color:hairColor });
    }

    // Accessories
    if (currentAccessory === 'sword') {
      parts.push({ scale:[0.1,1.0,0.05], transform:mat4Translate(0.9,0.5,0), color:[0.75,0.75,0.75] });
      parts.push({ scale:[0.28,0.08,0.08], transform:mat4Translate(0.9,0.0,0), color:[0.75,0.75,0.75] });
      parts.push({ scale:[0.1,0.25,0.1], transform:mat4Translate(0.9,-0.15,0), color:[0.55,0.3,0.07] });
    } else if (currentAccessory === 'shield') {
      parts.push({ scale:[0.7,0.8,0.1], transform:mat4Translate(-0.9,0.5,0), color:[0.13,0.59,0.95] });
      parts.push({ scale:[0.25,0.25,0.05], transform:mat4Translate(-0.9,0.5,0.07), color:[1,0.85,0.2] });
    } else if (currentAccessory === 'wings') {
      parts.push({ scale:[0.7,0.45,0.1], transform:mat4Translate(-0.65,1.0,-0.4), color:[0.95,0.95,0.95] });
      parts.push({ scale:[0.7,0.45,0.1], transform:mat4Translate(0.65,1.0,-0.4), color:[0.95,0.95,0.95] });
    } else if (currentAccessory === 'cape') {
      parts.push({ scale:[0.9,1.3,0.08], transform:mat4Translate(0,0.3,-0.42), color:[0.61,0.35,0.71] });
    } else if (currentAccessory === 'backpack') {
      parts.push({ scale:[0.55,0.6,0.35], transform:mat4Translate(0,0.65,-0.52), color:[0.9,0.49,0.14] });
    }

    return parts;
  }

  // --- Draw unit box ---
  function drawPart(modelMat, color, isLit) {
    const prog = isLit ? shaderLit : shaderFlat;
    gl.useProgram(prog);
    const mvp = mat4Mul(projMat, mat4Mul(viewMat, modelMat));
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, mvp);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uModel'), false, modelMat);
    gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), color[0], color[1], color[2]);
    if (isLit) gl.uniform3f(gl.getUniformLocation(prog, 'uLightDir'), 0.4, 0.7, 0.5);
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

  // --- Draw GLB mesh ---
  function drawGLBMesh(mesh, modelMat) {
    const prog = shaderLit;
    gl.useProgram(prog);
    const mvp = mat4Mul(projMat, mat4Mul(viewMat, modelMat));
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uMVP'), false, mvp);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, 'uModel'), false, modelMat);
    gl.uniform3f(gl.getUniformLocation(prog, 'uColor'), mesh.color[0], mesh.color[1], mesh.color[2]);
    gl.uniform3f(gl.getUniformLocation(prog, 'uLightDir'), 0.4, 0.7, 0.5);
    gl.uniform1f(gl.getUniformLocation(prog, 'uUseTexture'), 0.0);

    const tmpPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tmpPos);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.DYNAMIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0);

    const tmpNorm = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tmpNorm);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals || mesh.positions, gl.DYNAMIC_DRAW);
    const normLoc = gl.getAttribLocation(prog, 'aNormal');
    gl.enableVertexAttribArray(normLoc);
    gl.vertexAttribPointer(normLoc, 3, gl.FLOAT, false, 0, 0);

    if (mesh.indices && mesh.indices.length > 0) {
      const tmpIdx = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, tmpIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
      gl.drawElements(gl.TRIANGLES, mesh.indices.length, mesh.indices.BYTES_PER_ELEMENT === 4 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
      gl.deleteBuffer(tmpIdx);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, mesh.positions.length / 3);
    }

    gl.deleteBuffer(tmpPos);
    gl.deleteBuffer(tmpNorm);
  }

  let projMat, viewMat;

  function render() {
    if (!gl || !canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth * dpr;
    const h = canvas.clientHeight * dpr;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.82, 0.88, 0.95, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    projMat = mat4Perspective(Math.PI / 5, canvas.width / canvas.height, 0.1, 100);
    viewMat = mat4LookAt([0, 1.4, 6], [0, 0.8, 0], [0, 1, 0]);

    const rotMat = mat4Mul(mat4RotateY(rotY), mat4RotateX(rotX));
    const baseMat = mat4Mul(mat4Translate(0, -0.4, 0), rotMat);

    // Draw GLB model
    if (glbModel && glbModel.meshes) {
      for (const mesh of glbModel.meshes) {
        const modelMat = mat4Mul(baseMat, mesh.transform);
        drawGLBMesh(mesh, modelMat);
      }
    }

    // Draw procedural accessories on top
    const accessories = buildAccessoryGeometry();
    for (const part of accessories) {
      const scaleMat = part.scale ? mat4Scale(part.scale[0], part.scale[1], part.scale[2]) : mat4Identity();
      const modelMat = mat4Mul(baseMat, mat4Mul(part.transform, scaleMat));
      drawPart(modelMat, part.color, !part.flat);
    }

    // Shadow
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    const shadowMat = mat4Mul(mat4Mul(mat4Translate(0,-0.98,0), rotMat), mat4Scale(1.5,0.01,1.5));
    drawPart(shadowMat, [0.65,0.7,0.78], false);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);

    if (autoRotate && !dragging) rotY += 0.008;
    animFrame = requestAnimationFrame(render);
  }

  function onMouseDown(e) { dragging=true; lastMX=e.clientX; lastMY=e.clientY; canvas.style.cursor='grabbing'; }
  function onMouseMove(e) { if(!dragging)return; rotY-=(e.clientX-lastMX)*0.01; rotX-=(e.clientY-lastMY)*0.01; rotX=Math.max(-1.2,Math.min(0.5,rotX)); lastMX=e.clientX; lastMY=e.clientY; }
  function onMouseUp() { dragging=false; canvas.style.cursor='grab'; }
  function onTouchStart(e) { if(e.touches.length===1){dragging=true;autoRotate=false;lastMX=e.touches[0].clientX;lastMY=e.touches[0].clientY;e.preventDefault();} }
  function onTouchMove(e) { if(!dragging||e.touches.length!==1)return; e.preventDefault(); rotY-=(e.touches[0].clientX-lastMX)*0.015; rotX-=(e.touches[0].clientY-lastMY)*0.015; rotX=Math.max(-1.2,Math.min(0.5,rotX)); lastMX=e.touches[0].clientX; lastMY=e.touches[0].clientY; }
  function onTouchEnd() { dragging=false; }

  function initCanvas(id) {
    canvas = document.getElementById(id);
    if (!canvas) return false;
    gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) { console.error('WebGL not available'); return false; }
    if (!initShaders()) return false;

    const unitBox = generateBox(1,1,1);
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

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseUp);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);
    return true;
  }

  function stop() { if(animFrame)cancelAnimationFrame(animFrame); animFrame=null; }

  window.render3DAvatar = function(avatarData) {
    if (!avatarData) return;
    if (avatarData.bodyColor) currentBodyColor = hexToGL(avatarData.bodyColor);
    if (avatarData.face) currentFace = avatarData.face;
    if (avatarData.hat !== undefined) currentHat = avatarData.hat;
    if (avatarData.accessory !== undefined) currentAccessory = avatarData.accessory;
    if (avatarData.hair !== undefined) currentHair = avatarData.hair;
    if (avatarData.shirt !== undefined) currentShirt = avatarData.shirt;
    if (avatarData.pants !== undefined) currentPants = avatarData.pants;

    if (!canvas || !gl) {
      if (!initCanvas('avatar-3d')) return;
    }

    if (!modelReady) {
      modelReady = true;
      loadGLB('/polytoria/source/Pauly-DS-yCzTt.glb').then(model => {
        glbModel = model;
      }).catch(e => console.error('Failed to load GLB:', e));
    }

    stop();
    render();
  };

  function hexToGL(hex) {
    const r=parseInt(hex.slice(1,3),16)/255;
    const g=parseInt(hex.slice(3,5),16)/255;
    const b=parseInt(hex.slice(5,7),16)/255;
    return [r,g,b];
  }

  window.addEventListener('DOMContentLoaded', function() {
    const c = document.getElementById('avatar-3d');
    if (c) initCanvas('avatar-3d');
  });

})();
