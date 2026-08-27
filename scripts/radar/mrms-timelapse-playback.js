(() => {
  const TARGET_2X_KEYFRAMES = 90;
  const TIMELAPSE_TRANSITION_MS = 55;
  const TIMELAPSE_END_HOLD_MS = 250;
  const TIMELAPSE_LOOKAHEAD = 6;
  const PATCH_RETRY_MS = 50;
  const PATCH_TIMEOUT_MS = 10000;
  const startedAt = Date.now();

  function readyToPatch() {
    try {
      return (
        typeof playbackLoop === "function" &&
        typeof playbackIntervalMs === "function" &&
        typeof warmAround === "function" &&
        typeof primePlaybackBuffer === "function" &&
        typeof loadFrameSource === "function" &&
        typeof showFrame === "function" &&
        typeof updateFrameUi === "function" &&
        typeof speedSelect !== "undefined"
      );
    } catch (_) {
      return false;
    }
  }

  function speedValue() {
    return Math.max(0.25, Number(speedSelect?.value) || 1);
  }

  function playbackStride() {
    if (speedValue() < 2 || !Array.isArray(frames) || frames.length < 2) return 1;
    return Math.max(1, Math.ceil(frames.length / TARGET_2X_KEYFRAMES));
  }

  function nextPlaybackIndex() {
    if (!frames.length) return 0;
    if (currentFrameIndex >= frames.length - 1) return 0;
    return Math.min(frames.length - 1, currentFrameIndex + playbackStride());
  }

  function compileBlendShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "MRMS blend shader compile failed";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function ensureBlendSupport() {
    const layer = radarLayer;
    if (!layer?.gl || !layer.texture || !layer.positionBuffer || !layer.uvBuffer) return false;
    if (layer.__zwxBlendInstalled) return true;

    const gl = layer.gl;
    const vertexSource = `
      precision highp float;
      uniform mat4 u_matrix;
      attribute vec2 a_pos;
      attribute vec2 a_uv;
      varying vec2 v_uv;
      void main(){
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
        v_uv = a_uv;
      }
    `;
    const fragmentSource = `
      precision mediump float;
      uniform sampler2D u_texture_a;
      uniform sampler2D u_texture_b;
      uniform float u_mix;
      uniform float u_opacity;
      varying vec2 v_uv;
      void main(){
        vec4 a = texture2D(u_texture_a, v_uv);
        vec4 b = texture2D(u_texture_b, v_uv);
        vec4 radar = mix(a, b, u_mix);
        gl_FragColor = vec4(radar.rgb, radar.a * u_opacity);
      }
    `;

    const vertexShader = compileBlendShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compileBlendShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const blendProgram = gl.createProgram();
    gl.attachShader(blendProgram, vertexShader);
    gl.attachShader(blendProgram, fragmentShader);
    gl.linkProgram(blendProgram);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(blendProgram, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(blendProgram) || "MRMS blend shader link failed");
    }

    const blendTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, blendTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    layer.__zwxBlendInstalled = true;
    layer.__zwxBlendProgram = blendProgram;
    layer.__zwxBlendTexture = blendTexture;
    layer.__zwxBlendTextureInitialized = false;
    layer.__zwxBlendTextureWidth = 0;
    layer.__zwxBlendTextureHeight = 0;
    layer.__zwxBlendActive = false;
    layer.__zwxBlendFactor = 0;

    const originalRender = layer.render;
    const originalSetImage = layer.setImage;
    const originalOnRemove = layer.onRemove;

    layer.__zwxUploadBlendTarget = function (imageToUpload) {
      const width = Number(imageToUpload?.width || imageToUpload?.naturalWidth || 0);
      const height = Number(imageToUpload?.height || imageToUpload?.naturalHeight || 0);
      if (!width || !height) return false;

      gl.bindTexture(gl.TEXTURE_2D, this.__zwxBlendTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== undefined) {
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
      }

      if (
        this.__zwxBlendTextureInitialized &&
        width === this.__zwxBlendTextureWidth &&
        height === this.__zwxBlendTextureHeight
      ) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, imageToUpload);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imageToUpload);
        this.__zwxBlendTextureWidth = width;
        this.__zwxBlendTextureHeight = height;
        this.__zwxBlendTextureInitialized = true;
      }
      return true;
    };

    layer.__zwxBeginBlend = function (targetSource) {
      if (!this.__zwxUploadBlendTarget(targetSource)) return false;
      this.__zwxBlendFactor = 0;
      this.__zwxBlendActive = true;
      this.map?.triggerRepaint();
      return true;
    };

    layer.__zwxSetBlend = function (value) {
      this.__zwxBlendFactor = Math.max(0, Math.min(1, Number(value) || 0));
      this.map?.triggerRepaint();
    };

    layer.__zwxCancelBlend = function () {
      this.__zwxBlendFactor = 0;
      this.__zwxBlendActive = false;
      this.map?.triggerRepaint();
    };

    layer.__zwxCommitBlend = function () {
      if (!this.__zwxBlendActive) return;

      const oldTexture = this.texture;
      this.texture = this.__zwxBlendTexture;
      this.__zwxBlendTexture = oldTexture;

      const oldWidth = this.textureWidth;
      const oldHeight = this.textureHeight;
      const oldInitialized = this.textureInitialized;
      this.textureWidth = this.__zwxBlendTextureWidth;
      this.textureHeight = this.__zwxBlendTextureHeight;
      this.textureInitialized = this.__zwxBlendTextureInitialized;
      this.__zwxBlendTextureWidth = oldWidth;
      this.__zwxBlendTextureHeight = oldHeight;
      this.__zwxBlendTextureInitialized = oldInitialized;

      this.__zwxBlendFactor = 0;
      this.__zwxBlendActive = false;
      this.map?.triggerRepaint();
    };

    layer.render = function (renderGl, matrix) {
      if (!this.__zwxBlendActive) {
        return originalRender.call(this, renderGl, matrix);
      }
      if (!this.visible || !this.__zwxBlendProgram || !this.texture || !this.__zwxBlendTexture) return;

      renderGl.useProgram(this.__zwxBlendProgram);
      renderGl.disable(renderGl.DEPTH_TEST);
      renderGl.enable(renderGl.BLEND);
      renderGl.blendEquation(renderGl.FUNC_ADD);
      renderGl.blendFunc(renderGl.SRC_ALPHA, renderGl.ONE_MINUS_SRC_ALPHA);

      renderGl.uniformMatrix4fv(
        renderGl.getUniformLocation(this.__zwxBlendProgram, "u_matrix"),
        false,
        matrix
      );
      renderGl.uniform1f(
        renderGl.getUniformLocation(this.__zwxBlendProgram, "u_mix"),
        this.__zwxBlendFactor
      );
      renderGl.uniform1f(
        renderGl.getUniformLocation(this.__zwxBlendProgram, "u_opacity"),
        this.opacity
      );

      const posLocation = renderGl.getAttribLocation(this.__zwxBlendProgram, "a_pos");
      renderGl.bindBuffer(renderGl.ARRAY_BUFFER, this.positionBuffer);
      renderGl.enableVertexAttribArray(posLocation);
      renderGl.vertexAttribPointer(posLocation, 2, renderGl.FLOAT, false, 0, 0);

      const uvLocation = renderGl.getAttribLocation(this.__zwxBlendProgram, "a_uv");
      renderGl.bindBuffer(renderGl.ARRAY_BUFFER, this.uvBuffer);
      renderGl.enableVertexAttribArray(uvLocation);
      renderGl.vertexAttribPointer(uvLocation, 2, renderGl.FLOAT, false, 0, 0);

      renderGl.activeTexture(renderGl.TEXTURE0);
      renderGl.bindTexture(renderGl.TEXTURE_2D, this.texture);
      renderGl.uniform1i(
        renderGl.getUniformLocation(this.__zwxBlendProgram, "u_texture_a"),
        0
      );

      renderGl.activeTexture(renderGl.TEXTURE1);
      renderGl.bindTexture(renderGl.TEXTURE_2D, this.__zwxBlendTexture);
      renderGl.uniform1i(
        renderGl.getUniformLocation(this.__zwxBlendProgram, "u_texture_b"),
        1
      );

      renderGl.drawArrays(renderGl.TRIANGLES, 0, 6);
    };

    layer.setImage = function (source) {
      this.__zwxCancelBlend();
      return originalSetImage.call(this, source);
    };

    layer.onRemove = function (mapLike, removeGl) {
      if (this.__zwxBlendTexture) removeGl.deleteTexture(this.__zwxBlendTexture);
      if (this.__zwxBlendProgram) removeGl.deleteProgram(this.__zwxBlendProgram);
      this.__zwxBlendTexture = null;
      this.__zwxBlendProgram = null;
      this.__zwxBlendInstalled = false;
      return originalOnRemove.call(this, mapLike, removeGl);
    };

    return true;
  }

  async function blendToFrame(index, generation) {
    if (!frames.length) return false;
    const normalized = (Number(index) + frames.length) % frames.length;
    const frame = frames[normalized];
    const source = await loadFrameSource(frame);

    if (!isPlaying || generation !== playbackGeneration) return false;
    if (!ensureBlendSupport()) {
      return showFrame(normalized, { quiet: true });
    }

    const layer = radarLayer;
    if (!layer.__zwxBeginBlend(source)) {
      return showFrame(normalized, { quiet: true });
    }

    const transitionStarted = performance.now();
    return new Promise(resolve => {
      function step(now) {
        if (
          !isPlaying ||
          generation !== playbackGeneration ||
          radarLayer !== layer
        ) {
          layer.__zwxCancelBlend?.();
          resolve(false);
          return;
        }

        const linear = Math.min(1, (now - transitionStarted) / TIMELAPSE_TRANSITION_MS);
        const eased = linear * linear * (3 - (2 * linear));
        layer.__zwxSetBlend(eased);

        if (linear < 1) {
          requestAnimationFrame(step);
          return;
        }

        layer.__zwxCommitBlend();
        currentFrameIndex = normalized;
        updateFrameUi();
        warmAround(normalized);
        resolve(true);
      }

      requestAnimationFrame(step);
    });
  }

  function patch() {
    if (!readyToPatch()) {
      if (Date.now() - startedAt < PATCH_TIMEOUT_MS) {
        window.setTimeout(patch, PATCH_RETRY_MS);
      }
      return;
    }

    if (window.__ZWX_MRMS_TIMELAPSE_PATCHED__) return;
    window.__ZWX_MRMS_TIMELAPSE_PATCHED__ = true;

    const originalPlaybackIntervalMs = playbackIntervalMs;
    const originalWarmAround = warmAround;
    const originalPrimePlaybackBuffer = primePlaybackBuffer;

    playbackIntervalMs = function () {
      if (speedValue() >= 2) return TIMELAPSE_TRANSITION_MS;
      return originalPlaybackIntervalMs();
    };

    warmAround = function (index) {
      if (speedValue() < 2) {
        return originalWarmAround(index);
      }
      if (!frames.length) return;

      const stride = playbackStride();
      const ahead = Math.min(TIMELAPSE_LOOKAHEAD, frames.length - 1);
      for (let offset = 1; offset <= ahead; offset += 1) {
        const target = Math.min(frames.length - 1, index + (offset * stride));
        loadFrameSource(frames[target]).catch(() => {});
      }

      const previous = Math.max(0, index - stride);
      loadFrameSource(frames[previous]).catch(() => {});
    };

    primePlaybackBuffer = async function (startIndex) {
      if (speedValue() < 2) {
        return originalPrimePlaybackBuffer(startIndex);
      }
      if (!frames.length) return;

      const stride = playbackStride();
      const count = Math.min(TIMELAPSE_LOOKAHEAD, frames.length);
      const jobs = [];
      for (let offset = 0; offset < count; offset += 1) {
        const target = Math.min(frames.length - 1, startIndex + (offset * stride));
        jobs.push(loadFrameSource(frames[target]));
      }
      await Promise.all(jobs);
      warmAround(startIndex);
    };

    playbackLoop = async function (generation) {
      if (!isPlaying || generation !== playbackGeneration || frames.length < 2) return;

      const cycleStarted = performance.now();
      const next = nextPlaybackIndex();
      let advanced = false;

      if (speedValue() >= 2 && next !== 0) {
        advanced = await blendToFrame(next, generation);
      } else {
        advanced = await showFrame(next, { quiet: true });
      }

      if (!advanced || !isPlaying || generation !== playbackGeneration) return;

      const atNewest = currentFrameIndex === frames.length - 1;
      const workTime = performance.now() - cycleStarted;
      const cadenceDelay = Math.max(0, playbackIntervalMs() - workTime);
      const endHold = atNewest
        ? (speedValue() >= 2 ? TIMELAPSE_END_HOLD_MS : END_FRAME_HOLD_MS)
        : 0;

      window.setTimeout(
        () => playbackLoop(generation),
        cadenceDelay + endHold
      );
    };

    speedSelect.addEventListener("change", () => {
      radarLayer?.__zwxCancelBlend?.();
      warmAround(currentFrameIndex);
    });

    console.info(
      "MRMS 2x smooth timelapse enabled:",
      `${TIMELAPSE_TRANSITION_MS}ms GPU blends, target ~${TARGET_2X_KEYFRAMES} key scans per long loop`
    );
  }

  patch();
})();
