(() => {
  const TIMELAPSE_FRAME_STRIDE = 8;
  const TIMELAPSE_TRANSITION_MS = 55;
  const TIMELAPSE_END_HOLD_MS = 250;
  const TIMELAPSE_LOOKAHEAD = 8;
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
    // Same 2x meteorological timelapse rate at every history length.
    // Eight ~2-minute MRMS scans equals about 16 weather-minutes per transition.
    return Math.max(1, Math.min(TIMELAPSE_FRAME_STRIDE, frames.length - 1));
  }

  function nextPlaybackIndex() {
    if (!frames.length) return 0;
    if (currentFrameIndex >= frames.length - 1) return 0;
    return Math.min(frames.length - 1, currentFrameIndex + playbackStride());
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || "MRMS timelapse shader compile failed";
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function ensureBlendSupport() {
    const layer = radarLayer;
    if (!layer?.gl || !layer.texture || !layer.positionBuffer || !layer.uvBuffer) return false;
    if (layer.__zwxBlendV2Installed) return true;

    const gl = layer.gl;
    const vertexSource = `
      precision highp float;
      uniform mat4 u_matrix;
      attribute vec2 a_pos;
      attribute vec2 a_uv;
      varying vec2 v_uv;
      void main() {
        gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
        v_uv = a_uv;
      }
    `;

    // Blend in premultiplied-alpha space, then convert back to straight alpha
    // before compositing over the Mapbox basemap. This prevents transparent
    // pixels from injecting dirty RGB values during the transition.
    const fragmentSource = `
      precision mediump float;
      uniform sampler2D u_texture_a;
      uniform sampler2D u_texture_b;
      uniform float u_mix;
      uniform float u_opacity;
      varying vec2 v_uv;

      void main() {
        vec4 a = texture2D(u_texture_a, v_uv);
        vec4 b = texture2D(u_texture_b, v_uv);

        vec3 aPremul = a.rgb * a.a;
        vec3 bPremul = b.rgb * b.a;
        float alpha = mix(a.a, b.a, u_mix);
        vec3 premul = mix(aPremul, bPremul, u_mix);
        vec3 rgb = alpha > 0.0001 ? premul / alpha : vec3(0.0);

        gl_FragColor = vec4(rgb, alpha * u_opacity);
      }
    `;

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "MRMS timelapse shader link failed");
    }

    const targetTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, targetTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);

    layer.__zwxBlendV2Installed = true;
    layer.__zwxBlendV2Program = program;
    layer.__zwxBlendV2Texture = targetTexture;
    layer.__zwxBlendV2TextureInitialized = false;
    layer.__zwxBlendV2TextureWidth = 0;
    layer.__zwxBlendV2TextureHeight = 0;
    layer.__zwxBlendV2Active = false;
    layer.__zwxBlendV2Factor = 0;

    const originalRender = layer.render;
    const originalSetImage = layer.setImage;
    const originalOnRemove = layer.onRemove;

    layer.__zwxUploadBlendV2Target = function (image) {
      const width = Number(image?.width || image?.naturalWidth || 0);
      const height = Number(image?.height || image?.naturalHeight || 0);
      if (!width || !height) return false;

      const renderGl = this.gl;
      renderGl.activeTexture(renderGl.TEXTURE1);
      renderGl.bindTexture(renderGl.TEXTURE_2D, this.__zwxBlendV2Texture);
      renderGl.pixelStorei(renderGl.UNPACK_FLIP_Y_WEBGL, false);
      renderGl.pixelStorei(renderGl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (renderGl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== undefined) {
        renderGl.pixelStorei(renderGl.UNPACK_COLORSPACE_CONVERSION_WEBGL, renderGl.NONE);
      }

      if (
        this.__zwxBlendV2TextureInitialized &&
        width === this.__zwxBlendV2TextureWidth &&
        height === this.__zwxBlendV2TextureHeight
      ) {
        renderGl.texSubImage2D(
          renderGl.TEXTURE_2D, 0, 0, 0,
          renderGl.RGBA, renderGl.UNSIGNED_BYTE, image
        );
      } else {
        renderGl.texImage2D(
          renderGl.TEXTURE_2D, 0, renderGl.RGBA,
          renderGl.RGBA, renderGl.UNSIGNED_BYTE, image
        );
        this.__zwxBlendV2TextureWidth = width;
        this.__zwxBlendV2TextureHeight = height;
        this.__zwxBlendV2TextureInitialized = true;
      }

      // Leave Mapbox/custom-layer state on texture unit 0.
      renderGl.activeTexture(renderGl.TEXTURE0);
      return true;
    };

    layer.__zwxBeginBlendV2 = function (source) {
      if (!this.__zwxUploadBlendV2Target(source)) return false;
      this.__zwxBlendV2Factor = 0;
      this.__zwxBlendV2Active = true;
      this.map?.triggerRepaint();
      return true;
    };

    layer.__zwxSetBlendV2 = function (value) {
      this.__zwxBlendV2Factor = Math.max(0, Math.min(1, Number(value) || 0));
      this.map?.triggerRepaint();
    };

    layer.__zwxCancelBlendV2 = function () {
      this.__zwxBlendV2Factor = 0;
      this.__zwxBlendV2Active = false;
      this.gl?.activeTexture(this.gl.TEXTURE0);
      this.map?.triggerRepaint();
    };

    layer.__zwxCommitBlendV2 = function () {
      if (!this.__zwxBlendV2Active) return;

      const oldTexture = this.texture;
      this.texture = this.__zwxBlendV2Texture;
      this.__zwxBlendV2Texture = oldTexture;

      const oldWidth = this.textureWidth;
      const oldHeight = this.textureHeight;
      const oldInitialized = this.textureInitialized;
      this.textureWidth = this.__zwxBlendV2TextureWidth;
      this.textureHeight = this.__zwxBlendV2TextureHeight;
      this.textureInitialized = this.__zwxBlendV2TextureInitialized;
      this.__zwxBlendV2TextureWidth = oldWidth;
      this.__zwxBlendV2TextureHeight = oldHeight;
      this.__zwxBlendV2TextureInitialized = oldInitialized;

      this.__zwxBlendV2Factor = 0;
      this.__zwxBlendV2Active = false;
      this.gl?.activeTexture(this.gl.TEXTURE0);
      this.map?.triggerRepaint();
    };

    layer.render = function (renderGl, matrix) {
      if (!this.__zwxBlendV2Active) {
        return originalRender.call(this, renderGl, matrix);
      }

      if (!this.visible || !this.__zwxBlendV2Program || !this.texture || !this.__zwxBlendV2Texture) {
        return;
      }

      const blendProgram = this.__zwxBlendV2Program;
      renderGl.useProgram(blendProgram);
      renderGl.disable(renderGl.DEPTH_TEST);
      renderGl.enable(renderGl.BLEND);
      renderGl.blendEquation(renderGl.FUNC_ADD);
      renderGl.blendFunc(renderGl.SRC_ALPHA, renderGl.ONE_MINUS_SRC_ALPHA);

      renderGl.uniformMatrix4fv(
        renderGl.getUniformLocation(blendProgram, "u_matrix"),
        false,
        matrix
      );
      renderGl.uniform1f(
        renderGl.getUniformLocation(blendProgram, "u_mix"),
        this.__zwxBlendV2Factor
      );
      renderGl.uniform1f(
        renderGl.getUniformLocation(blendProgram, "u_opacity"),
        this.opacity
      );

      const posLocation = renderGl.getAttribLocation(blendProgram, "a_pos");
      renderGl.bindBuffer(renderGl.ARRAY_BUFFER, this.positionBuffer);
      renderGl.enableVertexAttribArray(posLocation);
      renderGl.vertexAttribPointer(posLocation, 2, renderGl.FLOAT, false, 0, 0);

      const uvLocation = renderGl.getAttribLocation(blendProgram, "a_uv");
      renderGl.bindBuffer(renderGl.ARRAY_BUFFER, this.uvBuffer);
      renderGl.enableVertexAttribArray(uvLocation);
      renderGl.vertexAttribPointer(uvLocation, 2, renderGl.FLOAT, false, 0, 0);

      renderGl.activeTexture(renderGl.TEXTURE0);
      renderGl.bindTexture(renderGl.TEXTURE_2D, this.texture);
      renderGl.uniform1i(renderGl.getUniformLocation(blendProgram, "u_texture_a"), 0);

      renderGl.activeTexture(renderGl.TEXTURE1);
      renderGl.bindTexture(renderGl.TEXTURE_2D, this.__zwxBlendV2Texture);
      renderGl.uniform1i(renderGl.getUniformLocation(blendProgram, "u_texture_b"), 1);

      renderGl.drawArrays(renderGl.TRIANGLES, 0, 6);

      // Critical: don't leak texture unit 1 into Mapbox's next draw call.
      renderGl.activeTexture(renderGl.TEXTURE0);
    };

    layer.setImage = function (source) {
      this.__zwxCancelBlendV2();
      return originalSetImage.call(this, source);
    };

    layer.onRemove = function (mapLike, removeGl) {
      if (this.__zwxBlendV2Texture) removeGl.deleteTexture(this.__zwxBlendV2Texture);
      if (this.__zwxBlendV2Program) removeGl.deleteProgram(this.__zwxBlendV2Program);
      this.__zwxBlendV2Texture = null;
      this.__zwxBlendV2Program = null;
      this.__zwxBlendV2Installed = false;
      removeGl.activeTexture(removeGl.TEXTURE0);
      return originalOnRemove.call(this, mapLike, removeGl);
    };

    return true;
  }

  async function blendToFrame(index, generation) {
    if (!frames.length) return false;

    const normalized = (Number(index) + frames.length) % frames.length;
    const frame = frames[normalized];
    let source;

    try {
      source = await loadFrameSource(frame);
    } catch (error) {
      console.warn("MRMS timelapse keyframe load failed", frame?.id, error);
      return false;
    }

    if (!isPlaying || generation !== playbackGeneration) return false;
    if (!ensureBlendSupport()) {
      return showFrame(normalized, { quiet: true });
    }

    const layer = radarLayer;
    if (!layer.__zwxBeginBlendV2(source)) {
      return showFrame(normalized, { quiet: true });
    }

    const transitionStarted = performance.now();

    return new Promise(resolve => {
      function step(now) {
        if (!isPlaying || generation !== playbackGeneration || radarLayer !== layer) {
          layer.__zwxCancelBlendV2?.();
          resolve(false);
          return;
        }

        // Linear progression avoids a tiny ease-in/ease-out pulse on every keyframe.
        const progress = Math.min(1, (now - transitionStarted) / TIMELAPSE_TRANSITION_MS);
        layer.__zwxSetBlendV2(progress);

        if (progress < 1) {
          requestAnimationFrame(step);
          return;
        }

        layer.__zwxCommitBlendV2();
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

    if (window.__ZWX_MRMS_TIMELAPSE_V2_PATCHED__) return;
    window.__ZWX_MRMS_TIMELAPSE_V2_PATCHED__ = true;

    const originalPlaybackIntervalMs = playbackIntervalMs;
    const originalWarmAround = warmAround;
    const originalPrimePlaybackBuffer = primePlaybackBuffer;

    playbackIntervalMs = function () {
      if (speedValue() >= 2) return TIMELAPSE_TRANSITION_MS;
      return originalPlaybackIntervalMs();
    };

    warmAround = function (index) {
      if (speedValue() < 2) return originalWarmAround(index);
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
      if (speedValue() < 2) return originalPrimePlaybackBuffer(startIndex);
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

      try {
        if (speedValue() >= 2 && next !== 0) {
          advanced = await blendToFrame(next, generation);
        } else {
          advanced = await showFrame(next, { quiet: true });
        }
      } catch (error) {
        console.warn("MRMS timelapse transition failed", error);
      }

      if (!isPlaying || generation !== playbackGeneration) return;

      if (!advanced) {
        window.setTimeout(() => playbackLoop(generation), 25);
        return;
      }

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
      radarLayer?.__zwxCancelBlendV2?.();
      warmAround(currentFrameIndex);
    });

    console.info(
      "MRMS 2x stable timelapse enabled:",
      `${TIMELAPSE_TRANSITION_MS}ms linear alpha-correct blends, fixed ${TIMELAPSE_FRAME_STRIDE}-scan stride`
    );
  }

  patch();
})();
