/**
 * Background Canvas — GIF-masked ASCII field + morphing shapes.
 * 
 * Uses gifuct-js to decode the gif frame by frame, then samples each frame
 * as a brightness mask to determine where ASCII characters appear.
 * 
 * Exposes Canvas.pulse() for recall effects.
 */
var Canvas = (function () {
  var canvas = document.getElementById('geo-canvas');
  var ctx = canvas.getContext('2d');

  // Frame-by-frame gif playback
  var frames = [];       // decoded frames from gifuct-js
  var frameIdx = 0;
  var frameTimer = 0;
  var frameDelay = 100;  // ms per frame (updated from gif data)
  var lastFrameTime = 0;

  // Offscreen canvas for compositing gif frames
  var gifCanvas = document.createElement('canvas');
  var gifCtx = gifCanvas.getContext('2d');

  // Mask sampling canvas (small for performance)
  var maskCanvas = document.createElement('canvas');
  var maskCtx = maskCanvas.getContext('2d');

  var width, height;
  var time = 0;
  var pulseIntensity = 0;
  var gifReady = false;

  // ASCII config
  var asciiChars = [' ', '.', '`', ',', ':', ';', '~', '+', '=', 'i', 'l', 'x', 'z', 'X', 'Y', '*', 'S', '%', '#', '&', '@'];
  var stepX = 12;
  var stepY = 14;
  var cols = 0;
  var rows = 0;

  // Morphing shapes
  var shapes = [];
  var SHAPE_COUNT = 4;

  var GREY = { r: 150, g: 150, b: 150 };
  var ACCENT = { r: 255, g: 69, b: 0 };

  // === Load and decode GIF with gifuct-js (global: window.gifuct) ===
  function loadGif() {
    fetch('ui/assets/bg.gif')
      .then(function (resp) { return resp.arrayBuffer(); })
      .then(function (buff) {
        var gif = gifuct.parseGIF(buff);
        frames = gifuct.decompressFrames(gif, true);
        if (frames.length > 0) {
          gifCanvas.width = frames[0].dims.width;
          gifCanvas.height = frames[0].dims.height;
          gifReady = true;
          console.log('[Canvas] GIF loaded: ' + frames.length + ' frames');
        }
      })
      .catch(function (err) {
        console.warn('[Canvas] Failed to load gif:', err);
      });
  }

  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    maskCanvas.width = Math.ceil(width / 4);
    maskCanvas.height = Math.ceil(height / 4);
    cols = Math.ceil(width / stepX);
    rows = Math.ceil(height / stepY);
    initShapes();
  }

  // === Render current gif frame to the gifCanvas, then scale to maskCanvas ===
  function updateMask(timestamp) {
    if (!gifReady || frames.length === 0) return null;

    // Advance frame based on delay
    if (timestamp - lastFrameTime > frameDelay) {
      frameIdx = (frameIdx + 1) % frames.length;
      lastFrameTime = timestamp;
      frameDelay = frames[frameIdx].delay || 100;

      // Draw the frame patch onto the gif canvas
      var frame = frames[frameIdx];
      var dims = frame.dims;
      var imageData = new ImageData(frame.patch, dims.width, dims.height);

      // Handle disposal (simplified: just draw over)
      if (frame.disposalType === 2) {
        gifCtx.clearRect(0, 0, gifCanvas.width, gifCanvas.height);
      }
      
      // Create temp canvas for this frame's patch
      var tempCanvas = document.createElement('canvas');
      tempCanvas.width = dims.width;
      tempCanvas.height = dims.height;
      var tempCtx = tempCanvas.getContext('2d');
      tempCtx.putImageData(imageData, 0, 0);
      
      gifCtx.drawImage(tempCanvas, dims.left, dims.top);
    }

    // Scale gif frame down to mask canvas
    maskCtx.drawImage(gifCanvas, 0, 0, maskCanvas.width, maskCanvas.height);
    return maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  }

  // === Draw ASCII where mask is bright ===
  function drawAscii(maskData) {
    if (!maskData) return;

    ctx.font = '11px "SF Mono", Consolas, monospace';

    var mw = maskCanvas.width;
    var scaleX = mw / width;
    var scaleY = maskCanvas.height / height;

    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x = c * stepX;
        var y = r * stepY;

        var mx = Math.floor(x * scaleX);
        var my = Math.floor(y * scaleY);
        var idx = (my * mw + mx) * 4;

        var red = maskData[idx];
        var green = maskData[idx + 1];
        var blue = maskData[idx + 2];
        var brightness = (red * 0.299 + green * 0.587 + blue * 0.114) / 255;

        if (brightness < 0.1) continue;

        var charIdx = Math.floor(brightness * (asciiChars.length - 1));
        var char = asciiChars[Math.min(charIdx, asciiChars.length - 1)];
        if (char === ' ') continue;

        var alpha = brightness * 0.35;
        ctx.fillStyle = 'rgba(' + GREY.r + ',' + GREY.g + ',' + GREY.b + ',' + alpha + ')';
        ctx.fillText(char, x, y);
      }
    }
  }

  // === Morphing Shapes ===
  function initShapes() {
    shapes = [];
    for (var i = 0; i < SHAPE_COUNT; i++) {
      shapes.push({
        x: width * 0.15 + Math.random() * width * 0.7,
        y: height * 0.15 + Math.random() * height * 0.7,
        size: 25 + Math.random() * 40,
        currentSides: 3 + Math.floor(Math.random() * 5),
        targetSides: 3 + Math.floor(Math.random() * 5),
        morphProgress: 0,
        morphSpeed: 0.002 + Math.random() * 0.002,
        rotation: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 0.0015,
        driftX: (Math.random() - 0.5) * 0.1,
        driftY: (Math.random() - 0.5) * 0.06,
        opacity: 0.05 + Math.random() * 0.04
      });
    }
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function drawMorphingShape(s) {
    var speed = s.morphSpeed;
    if (pulseIntensity > 0) speed *= 1 + pulseIntensity * 3;
    s.morphProgress += speed;

    if (s.morphProgress >= 1) {
      s.morphProgress = 0;
      s.currentSides = s.targetSides;
      s.targetSides = 3 + Math.floor(Math.random() * 6);
    }

    s.x += s.driftX;
    s.y += s.driftY;
    s.rotation += s.rotSpeed;

    if (s.x < -s.size * 2) s.x = width + s.size;
    if (s.x > width + s.size * 2) s.x = -s.size;
    if (s.y < -s.size * 2) s.y = height + s.size;
    if (s.y > height + s.size * 2) s.y = -s.size;

    var maxVerts = Math.max(s.currentSides, s.targetSides);
    var p = s.morphProgress;
    var ease = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;

    ctx.beginPath();
    for (var i = 0; i < maxVerts; i++) {
      var a1 = (i / s.currentSides) * Math.PI * 2 + s.rotation;
      var a2 = (i / s.targetSides) * Math.PI * 2 + s.rotation;
      var px = lerp(s.x + Math.cos(a1) * s.size, s.x + Math.cos(a2) * s.size, ease);
      var py = lerp(s.y + Math.sin(a1) * s.size, s.y + Math.sin(a2) * s.size, ease);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();

    ctx.strokeStyle = 'rgba(' + GREY.r + ',' + GREY.g + ',' + GREY.b + ',' + s.opacity + ')';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawShapes() {
    for (var i = 0; i < shapes.length; i++) {
      drawMorphingShape(shapes[i]);
    }
  }

  // === Main Loop ===
  function animate(timestamp) {
    time = timestamp;
    ctx.clearRect(0, 0, width, height);

    if (pulseIntensity > 0) {
      pulseIntensity -= 0.008;
      if (pulseIntensity < 0) pulseIntensity = 0;
    }

    var maskData = updateMask(timestamp);
    drawAscii(maskData);
    drawShapes();

    requestAnimationFrame(animate);
  }

  function pulse() {
    pulseIntensity = 1.0;
  }

  // === Init ===
  window.addEventListener('resize', resize);
  resize();
  loadGif();
  requestAnimationFrame(animate);

  return { pulse: pulse };
})();
