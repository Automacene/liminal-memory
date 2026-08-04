/**
 * Geometric Canvas — animated abstract tech shapes.
 * Slowly rotating/morphing polygons, floating nodes, connection lines.
 * Subtle, non-distracting background layer.
 */

const canvas = document.getElementById('geo-canvas');
const ctx = canvas.getContext('2d');

let width, height;
let shapes = [];
let particles = [];
let connections = [];
let time = 0;

const ACCENT = { r: 255, g: 69, b: 0 };
const GREY = { r: 180, g: 180, b: 180 };

function resize() {
  width = canvas.width = window.innerWidth;
  height = canvas.height = window.innerHeight;
  initShapes();
}

function initShapes() {
  shapes = [];
  particles = [];

  // Floating geometric shapes (hexagons, triangles, squares)
  const shapeCount = Math.floor((width * height) / 200000) + 4;
  for (let i = 0; i < shapeCount; i++) {
    shapes.push({
      x: Math.random() * width,
      y: Math.random() * height,
      size: 20 + Math.random() * 60,
      sides: [3, 4, 5, 6, 8][Math.floor(Math.random() * 5)],
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.003,
      driftX: (Math.random() - 0.5) * 0.15,
      driftY: (Math.random() - 0.5) * 0.1,
      opacity: 0.04 + Math.random() * 0.06,
      isAccent: Math.random() < 0.25,
      pulsePhase: Math.random() * Math.PI * 2,
      morphPhase: Math.random() * Math.PI * 2,
      morphSpeed: 0.001 + Math.random() * 0.002
    });
  }

  // Small floating particles (dots / nodes)
  const particleCount = Math.floor((width * height) / 80000) + 8;
  for (let i = 0; i < particleCount; i++) {
    particles.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.3,
      vy: (Math.random() - 0.5) * 0.2,
      size: 2 + Math.random() * 3,
      opacity: 0.1 + Math.random() * 0.2,
      isAccent: Math.random() < 0.2,
      pulse: Math.random() * Math.PI * 2
    });
  }
}

function drawPolygon(x, y, size, sides, rotation, morph) {
  ctx.beginPath();
  for (let i = 0; i <= sides; i++) {
    const angle = (i / sides) * Math.PI * 2 + rotation;
    // Morph: alternate vertices push in/out slightly
    const r = size + Math.sin(angle * 2 + morph) * size * 0.1;
    const px = x + Math.cos(angle) * r;
    const py = y + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawShapes() {
  for (const s of shapes) {
    // Drift
    s.x += s.driftX;
    s.y += s.driftY;
    s.rotation += s.rotSpeed;
    s.morphPhase += s.morphSpeed;

    // Wrap around screen
    if (s.x < -s.size * 2) s.x = width + s.size;
    if (s.x > width + s.size * 2) s.x = -s.size;
    if (s.y < -s.size * 2) s.y = height + s.size;
    if (s.y > height + s.size * 2) s.y = -s.size;

    // Pulse opacity
    const pulse = Math.sin(time * 0.001 + s.pulsePhase) * 0.02;
    const alpha = s.opacity + pulse;

    const color = s.isAccent ? ACCENT : GREY;
    ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
    ctx.lineWidth = 1;

    drawPolygon(s.x, s.y, s.size, s.sides, s.rotation, s.morphPhase);
    ctx.stroke();

    // Some shapes get a very faint fill
    if (s.isAccent) {
      ctx.fillStyle = `rgba(${ACCENT.r}, ${ACCENT.g}, ${ACCENT.b}, ${alpha * 0.3})`;
      ctx.fill();
    }
  }
}

function drawParticles() {
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.pulse += 0.02;

    // Wrap
    if (p.x < 0) p.x = width;
    if (p.x > width) p.x = 0;
    if (p.y < 0) p.y = height;
    if (p.y > height) p.y = 0;

    const pulseSize = p.size + Math.sin(p.pulse) * 1;
    const alpha = p.opacity + Math.sin(p.pulse) * 0.05;
    const color = p.isAccent ? ACCENT : GREY;

    ctx.beginPath();
    ctx.arc(p.x, p.y, pulseSize, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
    ctx.fill();
  }
}

function drawConnections() {
  const maxDist = 150;
  ctx.lineWidth = 0.5;

  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = particles[i].x - particles[j].x;
      const dy = particles[i].y - particles[j].y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < maxDist) {
        const alpha = (1 - dist / maxDist) * 0.06;
        const isAccentLine = particles[i].isAccent || particles[j].isAccent;
        const color = isAccentLine ? ACCENT : GREY;
        ctx.strokeStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(particles[i].x, particles[i].y);
        ctx.lineTo(particles[j].x, particles[j].y);
        ctx.stroke();
      }
    }
  }
}

function drawCrosshairs() {
  // Subtle crosshair markers at a few random positions (like schematic reference points)
  const markers = [
    { x: width * 0.15, y: height * 0.2 },
    { x: width * 0.85, y: height * 0.15 },
    { x: width * 0.1, y: height * 0.75 },
    { x: width * 0.9, y: height * 0.8 },
  ];

  ctx.lineWidth = 0.5;
  const alpha = 0.08 + Math.sin(time * 0.0008) * 0.03;
  ctx.strokeStyle = `rgba(${GREY.r}, ${GREY.g}, ${GREY.b}, ${alpha})`;

  for (const m of markers) {
    const size = 8;
    // Horizontal
    ctx.beginPath();
    ctx.moveTo(m.x - size, m.y);
    ctx.lineTo(m.x + size, m.y);
    ctx.stroke();
    // Vertical
    ctx.beginPath();
    ctx.moveTo(m.x, m.y - size);
    ctx.lineTo(m.x, m.y + size);
    ctx.stroke();
    // Circle
    ctx.beginPath();
    ctx.arc(m.x, m.y, size * 0.6, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function animate(timestamp) {
  time = timestamp;
  ctx.clearRect(0, 0, width, height);

  drawConnections();
  drawShapes();
  drawParticles();
  drawCrosshairs();

  requestAnimationFrame(animate);
}

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(animate);
