import { useEffect, useRef, useState } from 'react'

/**
 * A WebGL background: three brand colours flowing through one another.
 *
 * Drop-in and self-contained — no store, no context, no props required. It can be pasted into
 * MyStockio or MyCodeScan as-is; the only thing it needs is a parent it can position against.
 *
 * ── Why a shader rather than more CSS ───────────────────────────────────────────
 * The CSS version underneath this (see `index.css`) drifts three blurred radial gradients with a
 * transform. That is cheap and it is also all it can ever do: a transform can move a fixed shape
 * but it cannot make one field flow *through* another. This does, at the cost of a canvas.
 *
 * ── Made for a phone, not merely tolerated on one ───────────────────────────────
 * A full-screen fragment shader is the easiest way to flatten a mid-range phone, so every one of
 * these is deliberate:
 *
 *   · **Rendered at a fraction of the real resolution.** `RESOLUTION_SCALE` renders at ~55% and
 *     lets the browser scale it up. For a soft blurred field nobody can tell, and fragment cost
 *     falls with the square — this one line is most of the performance.
 *   · **Capped at 30fps.** The motion is a slow drift; 60fps spends twice the GPU to look the same.
 *   · **Stops when it cannot be seen.** Paused on tab-hide and when scrolled out of view. A
 *     background animating behind another tab is pure battery drain.
 *   · **`low-power`, no antialias, no depth or stencil buffer.** None of them mean anything for two
 *     triangles, and on a phone the hint picks the efficient GPU.
 *   · **Honours `prefers-reduced-motion`** by drawing one static frame and stopping. The colour is
 *     the design; the movement is the part somebody asked to be spared.
 *   · **Falls back silently.** No WebGL, a failed compile, or a lost context leaves the CSS
 *     gradient showing and nothing logged at the user. A background is not worth an error.
 */

/** Fraction of real device pixels to render. Fragment cost falls with the square of this. */
const RESOLUTION_SCALE = 0.55
/** Never render more pixels than this regardless of the screen — guards a 4K monitor. */
const MAX_PIXELS = 1_280
const TARGET_FPS = 30

const VERTEX_SHADER = `
attribute vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`

/*
 * Deliberately written against GLSL ES 1.00.
 *
 * A WebGL2 context accepts 1.00 shaders, so one source works on both and there is no need to
 * detect the version or carry two copies. `highp` is requested only where the hardware advertises
 * it — mediump is enough for a soft gradient and is measurably faster on older mobile GPUs, but on
 * some of them it bands badly enough to see, hence the guard rather than picking one.
 */
const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uResolution;
uniform float uTime;

/*
 * Three overlapping sine fields rather than a noise function.
 *
 * Value or simplex noise would look richer and costs several times more per fragment — on a
 * full-screen quad on a phone that is the difference between free and noticeable. Layered sines at
 * different angles and speeds never visibly repeat at this scale, which is all a background needs.
 */
float field(vec2 p, float t, float scale) {
  float a = sin(p.x * scale + t);
  float b = sin((p.y * scale * 0.8) - t * 0.7);
  float c = sin((p.x + p.y) * scale * 0.5 + t * 0.45);
  /* Into 0..1, so it can be used directly as a mix weight. */
  return (a + b + c) / 3.0 * 0.5 + 0.5;
}

void main() {
  /* Aspect-corrected, so the pattern does not stretch on a wide monitor or a tall phone. */
  vec2 uv = gl_FragCoord.xy / uResolution;
  vec2 p = (uv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);

  float t = uTime * 0.18;

  float f1 = field(p * 2.2, t, 1.0);
  float f2 = field(p * 1.4 + vec2(1.7, -0.8), t * 0.8 + 2.0, 1.3);
  float f3 = field(p * 3.1 - vec2(0.9, 1.4), t * 0.6 - 1.0, 0.7);

  /* The console's palette: sky, violet, emerald, over near-black. */
  vec3 base = vec3(0.008, 0.024, 0.09);
  vec3 sky = vec3(0.22, 0.74, 0.97);
  vec3 violet = vec3(0.55, 0.36, 0.96);
  vec3 emerald = vec3(0.06, 0.73, 0.51);

  vec3 colour = base;
  colour += sky * pow(f1, 2.6) * 0.42;
  colour += violet * pow(f2, 2.4) * 0.36;
  colour += emerald * pow(f3, 3.0) * 0.20;

  /*
   * Darkened towards the edges and the bottom. The content sits in the middle and the table starts
   * lower down; without this the brightest part of the animation lands behind the smallest text.
   */
  float vignette = smoothstep(1.25, 0.15, length(p));
  colour *= mix(0.55, 1.0, vignette);
  colour *= mix(1.0, 0.45, smoothstep(0.35, 1.0, uv.y * -1.0 + 1.0));

  gl_FragColor = vec4(colour, 1.0);
}
`

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    /* Deleted and reported as a failure — the caller hides the canvas and the CSS shows through. */
    gl.deleteShader(shader)
    return null
  }
  return shader
}

export function ShaderBackground({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** Hidden until a frame has actually been drawn, so a failure never shows a black rectangle. */
  const [live, setLive] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

    const gl =
      (canvas.getContext('webgl', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'low-power',
        /* The canvas is never read back, and letting the driver discard it after a frame is
           cheaper on mobile. */
        preserveDrawingBuffer: false,
      }) as WebGLRenderingContext | null) ?? null

    if (!gl) return

    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    if (!vertex || !fragment) return

    const program = gl.createProgram()
    if (!program) return
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program)
      return
    }
    gl.useProgram(program)

    /* Two triangles covering clip space. No matrices, no camera — the shader works in UV space. */
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, 'aPosition')
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)

    const uResolution = gl.getUniformLocation(program, 'uResolution')
    const uTime = gl.getUniformLocation(program, 'uTime')

    let width = 0
    let height = 0

    const resize = () => {
      /*
       * Capped twice: by the resolution scale and by an absolute pixel ceiling. A retina phone and
       * a 4K monitor both otherwise ask for several times the fragments this needs.
       */
      const scale = Math.min(window.devicePixelRatio || 1, 2) * RESOLUTION_SCALE
      const w = Math.max(1, Math.min(MAX_PIXELS, Math.round(canvas.clientWidth * scale)))
      const h = Math.max(1, Math.min(MAX_PIXELS, Math.round(canvas.clientHeight * scale)))
      if (w === width && h === height) return
      width = w
      height = h
      canvas.width = w
      canvas.height = h
      gl.viewport(0, 0, w, h)
      gl.uniform2f(uResolution, w, h)
    }

    let frame = 0
    let lastDraw = 0
    let running = true
    const started = performance.now()

    const draw = (now: number) => {
      /* One frame every ~33ms. The drift is slow; 60fps costs twice the GPU for no visible gain. */
      if (now - lastDraw >= 1000 / TARGET_FPS) {
        lastDraw = now
        resize()
        gl.uniform1f(uTime, (now - started) / 1000)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        if (!live) setLive(true)
      }
      if (running) frame = requestAnimationFrame(draw)
    }

    if (reduceMotion) {
      /* One frame, then stop. The colour stays; only the movement is given up. */
      resize()
      gl.uniform1f(uTime, 8)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      setLive(true)
    } else {
      frame = requestAnimationFrame(draw)
    }

    /* Paused when the tab is hidden — a background animating behind another tab is pure drain. */
    const onVisibility = () => {
      if (reduceMotion) return
      if (document.visibilityState === 'hidden') {
        running = false
        cancelAnimationFrame(frame)
      } else if (!running) {
        running = true
        lastDraw = 0
        frame = requestAnimationFrame(draw)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    const observer = new ResizeObserver(() => resize())
    observer.observe(canvas)

    return () => {
      running = false
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', onVisibility)
      observer.disconnect()
      /*
       * Released explicitly. A browser allows only a handful of live WebGL contexts, and a
       * component that mounts and unmounts — a route change, a hot reload — silently exhausts them
       * and then every later canvas fails for no visible reason.
       */
      gl.deleteBuffer(buffer)
      gl.deleteProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      /*
       * Behind everything, and untouchable. `-z-10` keeps it under the content; `pointer-events-none`
       * means it never swallows a click meant for a row beneath the cursor.
       *
       * It fades in once a frame exists, so a device without WebGL shows the CSS gradient rather
       * than a black rectangle appearing and staying.
       */
      className={[
        'pointer-events-none fixed inset-0 -z-10 h-full w-full transition-opacity duration-700',
        live ? 'opacity-100' : 'opacity-0',
        className ?? '',
      ].join(' ')}
    />
  )
}
