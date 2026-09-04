type ToolColor = { r: number; g: number; b: number; a: number }
type ChartData = { chartType: string; data: string; barColor: ToolColor; overlapped?: boolean; theme?: 'light' | 'dark'; requestedWidth?: number; granularity?: 'week' | 'biweekly' | 'monthly'; vatIncluded?: boolean; vatShowTotal?: boolean; tableColumns?: string }
const TOOL_ID = "b7b8983d-a536-4eeb-b76e-89d2f24bca63"
const DISPLAY_NAME = "Dynamic Charts"
const CHART_DATA_KEY = 'chartData'
const RED_NORTH: ToolColor = { r: 0.839, g: 0.082, b: 0.149, a: 1 }
const DEFAULTS: ChartData = {
  chartType: "vertical",
  data: "",
  barColor: RED_NORTH,
}
// ---- Shared design system (spacing, type, color) ----
// Axis/tick numbers vs. axis/tick text (category names, letters) get different sizes;
// line-chart point callouts are bigger still since they're the chart's main focal numbers.
const TICK_FONT_SIZE = 30
const TICK_LABEL_FONT_SIZE = 30
const VALUE_FONT_SIZE = 36
const LINE_VALUE_FONT_SIZE = 48
const LINE_VALUE_SUFFIX_SIZE = 40
const GRID_DASH = [16, 16]
// Every chart frame is clamped into this width range — wide enough to read comfortably at
// the new, much larger type scale, capped so it doesn't run away on data-heavy charts.
const MIN_CHART_WIDTH = 1000
const MAX_CHART_WIDTH = 1920
// Line charts read better narrower than the other chart types, so they get their own,
// tighter width range instead of the shared one above.
const MIN_LINE_CHART_WIDTH = 500
const MAX_LINE_CHART_WIDTH = 800
let editingFrameId: string | null = null

function clamp(v: number, min: number, max: number): number { return Math.max(min, Math.min(max, v)) }

// Every chart frame's width is clamped into [MIN_CHART_WIDTH, MAX_CHART_WIDTH]. When editing
// an existing chart, the frame's current on-canvas width (captured before it's redrawn) takes
// priority over the chart's own computed default, so a manual (width-only) resize survives an
// update. Height is never preserved this way — it always comes straight from the chart's own
// content, so an update can never leave content squashed or clipped inside a stale frame size
// (e.g. left over from before a typography change, or from a height that was never meant to
// be user-adjustable in the first place).
function resolveFrameSize(data: ChartData, defaultWidth: number, defaultHeight: number, minWidth: number = MIN_CHART_WIDTH, maxWidth: number = MAX_CHART_WIDTH): { width: number; height: number } {
  const width = clamp(Math.round(data.requestedWidth || defaultWidth), minWidth, maxWidth)
  const height = Math.max(1, Math.round(defaultHeight))
  return { width, height }
}

function normalizeColor(value: unknown, fallback: ToolColor): ToolColor {
  if (typeof value !== 'object' || value === null) return fallback
  const obj = value as Partial<ToolColor>
  const n = (v: unknown, f: number) => { const num = Number(v); return Number.isFinite(num) ? clamp(num, 0, 1) : f }
  return { r: n(obj.r, fallback.r), g: n(obj.g, fallback.g), b: n(obj.b, fallback.b), a: n(obj.a, fallback.a) }
}

function solidPaint(color: ToolColor): SolidPaint {
  return { type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: color.a }
}

function colorToHex(color: ToolColor): string {
  const ch = (v: number) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0').toUpperCase()
  return '#' + ch(color.r) + ch(color.g) + ch(color.b) + ch(color.a)
}

// Mixes a color toward a target color (amt 0..1, 1 = fully target). Used for "secondary
// series" tints — mixing toward the frame background (rather than a hardcoded white) keeps
// variants distinguishable in both the light and dark theme.
function mixToward(c: ToolColor, target: ToolColor, amt: number): ToolColor {
  return { r: clamp(c.r + (target.r - c.r) * amt, 0, 1), g: clamp(c.g + (target.g - c.g) * amt, 0, 1), b: clamp(c.b + (target.b - c.b) * amt, 0, 1), a: c.a }
}
// Pie/donut palette: first entry full color, each subsequent entry progressively closer to the background.
function seriesColorsLight(base: ToolColor, count: number, target: ToolColor): ToolColor[] {
  const out: ToolColor[] = []
  for (let i = 0; i < count; i++) {
    const amt = count > 1 ? (i / (count - 1)) * 0.8 : 0
    out.push(mixToward(base, target, amt))
  }
  return out
}

// Palette for the line chart: line 1 is the full accent red, line 2 a lighter red, line 3
// is forced to the theme's text color (black in light mode), and any further lines keep
// extending the red gradient.
function lineChartColors(base: ToolColor, count: number, theme: Theme): ToolColor[] {
  const redAmts = [0, 0.55, 0.3, 0.75, 0.15, 0.9]
  const out: ToolColor[] = []
  for (let i = 0; i < count; i++) {
    if (i === 2) { out.push(theme.text); continue }
    out.push(mixToward(base, theme.bg, redAmts[i] ?? 0.5))
  }
  return out
}

async function makeVectorPolygon(points: { x: number; y: number }[], fill: ToolColor, stroke?: ToolColor, strokeWeight = 2) {
  const vec = figma.createVector()
  const vertices = points.map(p => ({ x: p.x, y: p.y }))
  const segments = [] as any[]
  for (let i = 0; i < vertices.length; i++) segments.push({ start: i, end: (i + 1) % vertices.length })
  const regions = [{ loops: [vertices.map((_, i) => i)], windingRule: 'NONZERO' }]
  await vec.setVectorNetworkAsync({ vertices, segments, regions } as any)
  vec.fills = [solidPaint(fill)]
  if (stroke) {
    vec.strokes = [solidPaint(stroke)]
    vec.strokeWeight = strokeWeight
    try { vec.strokeAlign = 'INSIDE' } catch { }
  } else {
    // figma.createVector() defaults to a visible black stroke (a brand-new empty vector
    // network has no fill area of its own, so Figma gives it a stroke just to be visible at
    // all) — callers that only want a plain filled shape need this cleared explicitly, or
    // that default stroke silently survives untouched.
    vec.strokes = []
  }
  return vec
}

async function makeVectorPolyline(points: { x: number; y: number }[], stroke: ToolColor, weight = 3) {
  const vec = figma.createVector()
  const vertices = points.map(p => ({ x: p.x, y: p.y }))
  const segments = [] as any[]
  for (let i = 0; i < vertices.length - 1; i++) segments.push({ start: i, end: i + 1 })
  const regions: any[] = []
  await vec.setVectorNetworkAsync({ vertices, segments, regions } as any)
  vec.strokes = [solidPaint(stroke)]
  vec.strokeWeight = weight
  try { vec.strokeJoin = 'ROUND'; vec.strokeCap = 'ROUND' } catch { }
  vec.fills = []
  return vec
}

function htmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

interface DataEntry { label: string; value: number }
interface ProgressEntry { label: string; current: number; previous: number }

function parseData(str: string): DataEntry[] {
  const entries: DataEntry[] = []
  for (const part of str.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx > 0) {
      const label = trimmed.slice(0, colonIdx).trim()
      const valPart = trimmed.slice(colonIdx + 1).trim()
      const num = Number(valPart.split('|')[0].trim())
      if (!isNaN(num) && num >= 0) entries.push({ label, value: num })
    } else {
      const num = Number(trimmed)
      if (!isNaN(num) && num >= 0) entries.push({ label: String(entries.length + 1), value: num })
    }
  }
  return entries
}

function parseProgressData(str: string): ProgressEntry[] {
  const entries: ProgressEntry[] = []
  for (const part of str.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx > 0) {
      const label = trimmed.slice(0, colonIdx).trim()
      const valPart = trimmed.slice(colonIdx + 1).trim()
      const vals = valPart.split('|').map(v => Number(v.trim()))
      const cur = !isNaN(vals[0]) && vals[0] >= 0 ? vals[0] : 0
      const prev = vals.length > 1 && !isNaN(vals[1]) && vals[1] >= 0 ? vals[1] : 0
      entries.push({ label, current: cur, previous: prev })
    }
  }
  return entries
}

function formatValue(n: number): { numPart: string; suffix: string } {
  if (n >= 1000000) {
    const v = n / 1000000
    return { numPart: v % 1 === 0 ? String(v) : v.toFixed(1), suffix: 'M' }
  }
  if (n >= 1000) {
    const v = n / 1000
    return { numPart: v % 1 === 0 ? String(v) : v.toFixed(1), suffix: 'K' }
  }
  return { numPart: String(n), suffix: '' }
}

function formatAxisValue(n: number): string {
  const { numPart, suffix } = formatValue(n)
  return numPart + suffix
}

function niceScale(maxVal: number, targetTicks: number): { max: number; ticks: number[] } {
  if (maxVal <= 0) return { max: 1, ticks: [0, 1] }
  const rough = maxVal / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const residual = rough / mag
  let niceStep: number
  if (residual <= 1.5) niceStep = mag
  else if (residual <= 3) niceStep = 2 * mag
  else if (residual <= 7) niceStep = 5 * mag
  else niceStep = 10 * mag
  const niceMax = Math.ceil(maxVal / niceStep) * niceStep
  const ticks: number[] = []
  for (let v = 0; v <= niceMax; v += niceStep) ticks.push(Math.round(v * 1e6) / 1e6)
  return { max: niceMax, ticks }
}


// Solid x/y axis boundary lines for a cartesian plot area, drawn on top of (and distinct
// from) the dashed tick gridlines — (x0,y0) is the plot area's top-left corner.
// Built from vector paths rather than figma.createLine(): a LineNode's only size axis is
// its width (rotation is what angles it), so resize(0, height) silently makes a
// zero-length, invisible line instead of a vertical one.
async function addCartesianAxes(frame: FrameNode, theme: Theme, x0: number, y0: number, width: number, height: number) {
  const yAxis = await makeVectorPolyline([{ x: x0, y: y0 }, { x: x0, y: y0 + height }], theme.muted, 1)
  // Named so a chart's resize adaptation (see makeChartAdaptive) can single it out and
  // pin/stretch it appropriately instead of scaling it along with everything else.
  yAxis.name = 'y-axis-line'
  frame.appendChild(yAxis)

  const xAxis = await makeVectorPolyline([{ x: x0, y: y0 + height }, { x: x0 + width, y: y0 + height }], theme.muted, 1)
  xAxis.name = 'x-axis-line'
  frame.appendChild(xAxis)
}

// Wraps an already-positioned, already-sized node in an invisible anchor frame matching
// its exact bounds, at the same index in the parent's stacking order. The anchor is what
// gets the SCALE constraint (so it carries the node's position along as the chart resizes)
// while the node itself stays MIN/MIN-pinned inside it, so its own size/text never stretches.
function wrapInAnchor(frame: FrameNode, node: SceneNode & { x: number; y: number; width: number; height: number }, index: number): FrameNode {
  const x = node.x, y = node.y
  const w = Math.max(1, node.width), h = Math.max(1, node.height)
  const anchor = figma.createFrame()
  anchor.name = 'anchor'
  anchor.resize(w, h)
  anchor.x = x
  anchor.y = y
  anchor.fills = []
  anchor.clipsContent = false
  node.x = 0
  node.y = 0
  try { (node as any).constraints = { horizontal: 'MIN', vertical: 'MIN' } } catch { }
  anchor.appendChild(node)
  frame.insertChild(index, anchor)
  return anchor
}

// Makes a chart's content adapt to BOTH width and height changes — without deforming
// (circles stay circular, text never stretches) or overlapping (axes/labels track their
// true reference edges instead of drifting apart from each other).
//
// All "scale" content — bars, gridlines, data points/lines, value labels, and the y-axis
// line + its numeric/row labels — lives inside one "scale area" anchor that STRETCHes on
// BOTH axes to always exactly span [paddingLeft, frameWidth-paddingRight] ×
// [paddingTop, frameHeight-paddingBottom]. Content then SCALEs relative to that anchor
// (never the whole frame), which is what keeps a bar's length/height correctly proportional
// to its value in both directions, and keeps the y-axis line/numbers from drifting away
// from each other the way plain SCALE-relative-to-frame would (see the two bugs this
// exact drift caused previously: numbers detaching from the y-axis line on width resize,
// bars detaching from the axis on width resize). Inside the anchor, the y-axis line/labels
// specifically stay horizontally pinned (MIN) since they must never drift sideways, while
// still scaling vertically (their position is a fraction of the value scale, so it has to
// move as that scale grows/shrinks).
//
// Two kinds of content are deliberately kept OUTSIDE the scale area, each pinned to a fixed
// margin from the frame's own edges instead of scaling with the value axis:
// - 'legend': a fixed-size row, pinned bottom-left (its position is a flat margin, not a
//   fraction of anything).
// - 'category-label' (only passed for chart types that have one, e.g. vertical/grouped bar
//   labels below the bars): lives in a fixed-height zone pinned to the bottom edge, since
//   its offset below the bars is a constant margin — not part of the value scale — so it
//   must not be treated as "a fraction of the scale area" the way a gridline's position is.
function makeChartAdaptive(
  frame: FrameNode,
  paddingLeft: number, paddingRight: number, paddingTop: number, paddingBottom: number,
  frameWidth: number, frameHeight: number,
  categoryZoneHeight?: number
) {
  const children = [...frame.children]

  const scaleArea = figma.createFrame()
  scaleArea.name = 'scale-area'
  scaleArea.resize(Math.max(1, frameWidth - paddingLeft - paddingRight), Math.max(1, frameHeight - paddingTop - paddingBottom))
  scaleArea.x = paddingLeft
  scaleArea.y = paddingTop
  scaleArea.fills = []
  scaleArea.clipsContent = false

  let categoryZone: FrameNode | null = null
  if (categoryZoneHeight) {
    categoryZone = figma.createFrame()
    categoryZone.name = 'category-zone'
    categoryZone.resize(Math.max(1, frameWidth - paddingLeft - paddingRight), categoryZoneHeight)
    categoryZone.x = paddingLeft
    categoryZone.y = frameHeight - categoryZoneHeight
    categoryZone.fills = []
    categoryZone.clipsContent = false
  }

  children.forEach(child => {
    if (child.name === 'legend') {
      try { (child as any).constraints = { horizontal: 'MIN', vertical: 'MAX' } } catch { }
      return
    }
    if (child.name === 'category-label' && categoryZone) {
      const c = child as SceneNode & { x: number; y: number }
      c.x -= paddingLeft
      c.y -= (frameHeight - categoryZoneHeight!)
      const target = c.type === 'TEXT' ? wrapInAnchor(categoryZone, c, categoryZone.children.length) : (categoryZone.appendChild(c), c)
      try { (target as any).constraints = { horizontal: 'SCALE', vertical: 'MIN' } } catch { }
      return
    }
    const c = child as SceneNode & { x: number; y: number }
    c.x -= paddingLeft
    c.y -= paddingTop
    if (child.name === 'y-axis-line') {
      scaleArea.appendChild(c)
      try { (c as any).constraints = { horizontal: 'MIN', vertical: 'STRETCH' } } catch { }
      return
    }
    if (child.name === 'y-axis-label') {
      const target = wrapInAnchor(scaleArea, c, scaleArea.children.length)
      try { (target as any).constraints = { horizontal: 'MIN', vertical: 'SCALE' } } catch { }
      return
    }
    const target = c.type === 'TEXT' ? wrapInAnchor(scaleArea, c, scaleArea.children.length) : (scaleArea.appendChild(c), c)
    try { (target as any).constraints = { horizontal: 'SCALE', vertical: 'SCALE' } } catch { }
  })

  frame.insertChild(0, scaleArea)
  try { (scaleArea as any).constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' } } catch { }
  if (categoryZone) {
    frame.insertChild(0, categoryZone)
    try { (categoryZone as any).constraints = { horizontal: 'STRETCH', vertical: 'MAX' } } catch { }
  }
}

// For a chart whose whole composition should resize as one rigid unit (Radar, Force Graph,
// Petal Rose, Tree) rather than reflowing around fixed axis margins the way the
// cartesian bar/line charts do: content SCALEs relative to a 'plot-area' wrapper that itself
// STRETCHes to the frame (same two-tier structure as makeTimelineAdaptive), not directly off
// the frame being dragged — SCALE set straight on a frame's own immediate children didn't
// reliably carry a wrapped text anchor's *position* along with it in practice (the vector
// shapes moved, the label anchors didn't), while this nested form is the one already proven
// live-adaptive elsewhere in this file. Vectors/ellipses take the constraint directly (a
// scaled circle/line stays a clean scaled circle/line); text labels go through wrapInAnchor
// first so their position scales along with everything else while the glyphs themselves
// stay crisp instead of stretching.
function makeUniformScaleAdaptive(frame: FrameNode, size: number, frameHeight: number) {
  const children = [...frame.children]
  const plotArea = figma.createFrame()
  plotArea.name = 'plot-area'
  plotArea.resize(Math.max(1, size), Math.max(1, frameHeight))
  plotArea.x = 0
  plotArea.y = 0
  plotArea.fills = []
  plotArea.clipsContent = false

  children.forEach(child => {
    const target = child.type === 'TEXT' ? wrapInAnchor(plotArea, child, plotArea.children.length) : (plotArea.appendChild(child), child)
    // A circle (equal width/height ellipse) would otherwise stretch into an oval under a
    // non-uniform resize, since SCALE resizes each axis independently — locking its aspect
    // ratio (a native Figma feature that explicitly works with constraints-based resize,
    // not just auto layout) keeps it a true circle at whatever size that resize computes,
    // instead of freezing its size the way the CENTER-constraint anchor trick elsewhere in
    // this file does.
    if (child.type === 'ELLIPSE' && Math.abs(child.width - child.height) < 0.5) {
      try { child.lockAspectRatio() } catch { }
    }
    try { (target as any).constraints = { horizontal: 'SCALE', vertical: 'SCALE' } } catch { }
  })

  frame.insertChild(0, plotArea)
  try { (plotArea as any).constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' } } catch { }
}

// Timeline only: dates spread out with width (SCALE) live, with no redraw/refresh needed —
// same native Figma constraint mechanism as the other chart types above, not the
// redraw-on-resize watcher this plugin briefly used and then dropped (it introduced a
// worse problem: a resize that never settled). Row content stays vertically pinned (MIN)
// rather than scaling, since row spacing isn't a function of either axis of the date grid.
// Each row is its own auto-layout frame (see the row-entry loop in drawTimelineChart) —
// auto-layout children can't overlap each other by construction, so even though this
// function still can't make row spacing "grow" with height, it can no longer let a resize
// compress a label into overlapping its own bar.
function makeTimelineAdaptive(frame: FrameNode, paddingLeft: number, paddingRight: number, frameWidth: number, frameHeight: number) {
  const children = [...frame.children]
  const plotArea = figma.createFrame()
  plotArea.name = 'plot-area'
  plotArea.resize(Math.max(1, frameWidth - paddingLeft - paddingRight), Math.max(1, frameHeight))
  plotArea.x = paddingLeft
  plotArea.y = 0
  plotArea.fills = []
  plotArea.clipsContent = false

  children.forEach(child => {
    const c = child as SceneNode & { x: number }
    c.x = c.x - paddingLeft
    const target = c.type === 'TEXT' ? wrapInAnchor(plotArea, c, plotArea.children.length) : (plotArea.appendChild(c), c)
    // Row entries grow to fill extra height (their own auto-layout keeps the label safely
    // separated from its bar no matter how tall they end up, per drawTimelineChart above).
    // Gridlines STRETCH instead — their top margin (below the header) and bottom margin
    // stay fixed, so their *length* grows to track the frame instead of stopping short of
    // the new bottom the way a plain pin would. Everything else — month/sub-period headers
    // — stays pinned near the top, since header content is fixed-position, not something
    // that should drift downward as row content grows below it.
    const vertical = target.name === 'row-entry' ? 'SCALE' : target.name === 'grid-line' ? 'STRETCH' : 'MIN'
    try { (target as any).constraints = { horizontal: 'SCALE', vertical } } catch { }
  })

  frame.insertChild(0, plotArea)
  // STRETCH (not MIN) so plot-area's own height actually tracks the frame's height —
  // otherwise row-entries' vertical SCALE constraint would have nothing to scale into.
  try { (plotArea as any).constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' } } catch { }
}

// Wraps a row's already-positioned cells (their x/y are relative to the row's own top-left,
// i.e. as if the row started at (0,0)) in a small frame spanning that row's band, so the ROW
// can be repositioned/resized as a single unit for live vertical resize — without SCALE-ing
// the text nodes themselves, which would visibly distort their glyphs (the same reason
// wrapInAnchor exists elsewhere in this file, generalized to a whole row of cells at once
// instead of one node). Each cell gets its own horizontal alignment *within* the wrapper
// (left-aligned label vs. right-aligned price, etc.) — the wrapper's own resize later is set
// by the caller (see makeBoxListAdaptive), and Figma constraints compose correctly through
// nesting, so the cells keep their intended alignment regardless of how the wrapper resizes.
function wrapRowInAnchor(parent: FrameNode, cells: SceneNode[], aligns: ('MIN' | 'MAX')[], x: number, y: number, w: number, h: number): FrameNode {
  const wrapper = figma.createFrame()
  wrapper.name = 'row-anchor'
  wrapper.resize(Math.max(1, w), Math.max(1, h))
  wrapper.x = x
  wrapper.y = y
  wrapper.fills = []
  wrapper.clipsContent = false
  cells.forEach((c, i) => {
    wrapper.appendChild(c)
    try { (c as any).constraints = { horizontal: aligns[i], vertical: 'MIN' } } catch { }
  })
  parent.appendChild(wrapper)
  return wrapper
}

// Bordered-box row-list charts (Budget, Table): full two-axis live adaptation, matching
// every other chart type's resize behavior — width AND height, all native Figma constraints
// (no watcher, no redraw). The box STRETCHes on both axes to track the frame. Rows (wrapped
// via wrapRowInAnchor, named 'row-anchor') STRETCH horizontally (track box width) and SCALE
// vertically — their Y position moves proportionally as box height grows, spreading every
// row out evenly to fill a taller box instead of leaving them clustered at the top with dead
// space below. Divider lines are simple straight vectors (both the full-width 'row-divider's
// between rows and Table's 'col-divider's between columns), which Figma can scale directly
// with no distortion risk, so they skip the wrapper: 'row-divider' STRETCHes horizontally +
// SCALEs vertically (same reasoning as a row); 'col-divider' stays pinned horizontally (its
// column boundary doesn't move — column widths aren't reflowed on resize, to avoid
// distorting wrapped multi-line text) but still SCALEs vertically to keep spanning the box's
// full, growing height.
function makeBoxListAdaptive(frame: FrameNode, box: FrameNode) {
  try { (box as any).constraints = { horizontal: 'STRETCH', vertical: 'STRETCH' } } catch { }
  for (const child of [...box.children]) {
    if (child.name === 'row-divider') {
      try { (child as any).constraints = { horizontal: 'STRETCH', vertical: 'SCALE' } } catch { }
    } else if (child.name === 'col-divider') {
      try { (child as any).constraints = { horizontal: 'MIN', vertical: 'SCALE' } } catch { }
    } else {
      // 'row-anchor' wrappers, or any other direct box child.
      try { (child as any).constraints = { horizontal: 'STRETCH', vertical: 'SCALE' } } catch { }
    }
  }
  // Content outside the box (Budget's TOTAL row + footnote) needs to track the box's
  // growing bottom edge as it stretches taller — MAX keeps a fixed distance from the
  // frame's own bottom edge, which lines up with the box's bottom since both margins
  // (box-to-frame-bottom, element-to-frame-bottom) are fixed at creation.
  for (const child of [...frame.children]) {
    if (child === box) continue
    const horizontal = child.name === 'cell-right' ? 'MAX' : 'MIN'
    try { (child as any).constraints = { horizontal, vertical: 'MAX' } } catch { }
  }
}

// A dot whose SCALE constraint would otherwise stretch it into an oval as the chart
// widens — so it's wrapped in a small invisible frame that scales (and carries the dot's
// x-position with it), while the dot itself sits CENTER-constrained inside that wrapper,
// which keeps its own size fixed no matter how much the wrapper stretches.
function createAnchoredDot(x: number, y: number, size: number, color: ToolColor): FrameNode {
  const pad = 4
  const anchor = figma.createFrame()
  anchor.name = 'dot'
  anchor.resize(size + pad * 2, size + pad * 2)
  anchor.x = x - size / 2 - pad
  anchor.y = y - size / 2 - pad
  anchor.fills = []
  anchor.clipsContent = false
  const dot = figma.createEllipse()
  dot.resize(size, size)
  dot.x = pad
  dot.y = pad
  dot.fills = [ solidPaint(color) ]
  try { (dot as any).constraints = { horizontal: 'CENTER', vertical: 'CENTER' } } catch { }
  anchor.appendChild(dot)
  return anchor
}

const NOE_REGULAR: FontName = { family: 'Noe Display', style: 'Regular' }
const NOE_BOLD: FontName = { family: 'Noe Display', style: 'Bold' }
const MODERAT_LIGHT: FontName = { family: 'Moderat', style: 'Light' }
const MODERAT_REGULAR: FontName = { family: 'Moderat', style: 'Regular' }
const MODERAT_MEDIUM: FontName = { family: 'Moderat', style: 'Medium' }
const GRAY_TEXT: ToolColor = { r: 0.42, g: 0.42, b: 0.44, a: 1 }
const GRID_COLOR: ToolColor = { r: 0.88, g: 0.88, b: 0.88, a: 1 }
const BLACK: ToolColor = { r: 0.07, g: 0.07, b: 0.07, a: 1 }
const WHITE: ToolColor = { r: 1, g: 1, b: 1, a: 1 }
const TRACK_COLOR: ToolColor = { r: 0.93, g: 0.93, b: 0.93, a: 1 }
const GREEN_TEXT: ToolColor = { r: 0.13, g: 0.55, b: 0.13, a: 1 }

// "Positive" (light) vs "Negative" (dark) theme: swaps the frame background, text and
// gridline colors so a dark chart isn't just a white chart with an inverted bar color.
type Theme = { bg: ToolColor; text: ToolColor; muted: ToolColor; grid: ToolColor; track: ToolColor }
const LIGHT_THEME: Theme = { bg: WHITE, text: BLACK, muted: GRAY_TEXT, grid: GRID_COLOR, track: TRACK_COLOR }
const DARK_THEME: Theme = {
  bg: { r: 0.07, g: 0.07, b: 0.08, a: 1 },
  text: WHITE,
  muted: { r: 0.66, g: 0.66, b: 0.68, a: 1 },
  grid: { r: 0.26, g: 0.26, b: 0.28, a: 1 },
  track: { r: 0.2, g: 0.2, b: 0.22, a: 1 },
}
function getTheme(mode: ChartData['theme']): Theme {
  return mode === 'dark' ? DARK_THEME : LIGHT_THEME
}

async function loadFonts(): Promise<void> {
  await figma.loadFontAsync(NOE_REGULAR)
  await figma.loadFontAsync(MODERAT_LIGHT)
  try { await figma.loadFontAsync(NOE_BOLD) } catch { /* fallback to regular */ }
  try { await figma.loadFontAsync(MODERAT_MEDIUM) } catch { /* fallback to light */ }
  try { await figma.loadFontAsync(MODERAT_REGULAR) } catch { /* fallback to light */ }
}

async function createTextNode(text: string, font: FontName, fontSize: number, color: ToolColor) {
  await figma.loadFontAsync(font)
  const t = figma.createText()
  t.fontName = font
  t.characters = text
  t.fontSize = fontSize
  t.fills = [ solidPaint(color) ]
  return t
}

// Figma has no pure text-measurement call — the only way to know a string's real rendered
// width is to create a node and read it back — so this creates a disposable one, reads its
// natural single-line width, and removes it immediately, never touching the scene otherwise.
async function measureTextWidth(text: string, font: FontName, fontSize: number): Promise<number> {
  if (!text) return 0
  await figma.loadFontAsync(font)
  const t = figma.createText()
  t.fontName = font
  t.characters = text
  t.fontSize = fontSize
  const w = t.width || 0
  t.remove()
  return w
}

// A horizontal legend row (color swatch + label per entry), built with real Figma
// auto-layout instead of manual pixel math: each swatch+label pair is its own small
// auto-layout frame with counterAxisAlignItems 'CENTER', so the circle is always exactly
// vertically centered against the text next to it — and because it's a fixed-size ellipse
// governed by auto-layout (not a constraint-scaled node), it can never get squashed into an
// oval by a parent resize. The whole row hugs its content and is meant to be pinned (not
// scaled) by the caller so it stays put at the bottom-left of the chart.
async function createLegendRow(items: { color: ToolColor; label: string }[], theme: Theme): Promise<FrameNode> {
  const row = figma.createFrame()
  row.name = 'legend'
  row.layoutMode = 'HORIZONTAL'
  row.primaryAxisSizingMode = 'AUTO'
  row.counterAxisSizingMode = 'AUTO'
  row.counterAxisAlignItems = 'CENTER'
  row.itemSpacing = 44
  row.fills = []
  row.clipsContent = false

  const dotSize = 22
  for (const item of items) {
    const entry = figma.createFrame()
    entry.name = 'legend-entry'
    entry.layoutMode = 'HORIZONTAL'
    entry.primaryAxisSizingMode = 'AUTO'
    entry.counterAxisSizingMode = 'AUTO'
    entry.counterAxisAlignItems = 'CENTER'
    entry.itemSpacing = 14
    entry.fills = []
    entry.clipsContent = false

    const dot = figma.createEllipse()
    dot.resize(dotSize, dotSize)
    dot.fills = [ solidPaint(item.color) ]
    entry.appendChild(dot)

    const lbl = await createTextNode(item.label, MODERAT_REGULAR, TICK_LABEL_FONT_SIZE, theme.text)
    entry.appendChild(lbl)

    row.appendChild(entry)
  }
  return row
}

// Value callout used above bars / at line points / at bar ends: number in Noe Display
// with the K/M magnitude suffix rendered smaller, approximating the small-caps look
// used across the reference designs (e.g. "597K", "3.6M").
async function createValueLabel(n: number, size: number, color: ToolColor, font: FontName = NOE_REGULAR, suffixSize?: number): Promise<TextNode> {
  const { numPart, suffix } = formatValue(n)
  const text = numPart + suffix
  await figma.loadFontAsync(font)
  const t = figma.createText()
  t.fontName = font
  t.characters = text
  t.fontSize = size
  t.fills = [ solidPaint(color) ]
  if (suffix) {
    try { t.setRangeFontSize(numPart.length, text.length, suffixSize ?? Math.max(8, Math.round(size * 0.7))) } catch { }
  }
  return t
}

function createRect(w: number, h: number, fill: Paint, radius: number = 0) {
  const r = figma.createRectangle()
  r.resize(Math.max(1, w), Math.max(1, h))
  r.fills = [ fill ]
  r.strokeWeight = 0
  if (radius > 0) {
    try { r.cornerRadius = Math.min(radius, Math.min(w, h) / 2) } catch { }
  }
  return r
}

// Value label for a progress bar: sits inside (in insideColor, which should contrast against
// the bar fill) when the bar is wide enough, otherwise falls outside the bar end (in
// outsideColor) so it stays legible at low/zero values.
async function placeProgressValueLabel(frame: FrameNode, value: number, fillW: number, x0: number, rowY: number, rowH: number, insideColor: ToolColor, outsideColor: ToolColor): Promise<TextNode> {
  const fontSize = 28
  const txt = await createTextNode(String(value), MODERAT_MEDIUM, fontSize, insideColor)
  const fits = fillW > (txt.width || 0) + 64
  if (fits) {
    txt.x = x0 + fillW - (txt.width || 0) - 38
  } else {
    txt.fills = [ solidPaint(outsideColor) ]
    txt.x = x0 + fillW + 28
  }
  txt.y = rowY + rowH / 2 - fontSize / 2
  frame.appendChild(txt)
  return txt
}

async function drawVerticalChart(data: ChartData): Promise<FrameNode | null> {
  const entries = parseData(data.data)
  if (!entries.length) {
    figma.notify('No data entries to draw')
    return null
  }
  await loadFonts()
  const theme = getTheme(data.theme)

  const paddingLeft = 140
  const paddingRight = 90
  const paddingTop = 200
  const paddingBottom = 140
  const colCount = entries.length
  // Bars stretch to fill the full gridline width instead of leaving a gap: the frame
  // only grows past its minimum width once there are too many columns to fit at the
  // minimum readable bar width, growing all the way up to MAX_CHART_WIDTH before bars
  // start shrinking again to keep fitting.
  const colGapRatio = 0.35
  const minColWidth = 80
  const maxColWidth = 240
  const neededWidth = colCount * minColWidth + (colCount - 1) * minColWidth * colGapRatio
  const defaultWidth = paddingLeft + paddingRight + neededWidth
  // defaultWidth doubles as the floor here — the shared MIN_CHART_WIDTH is an arbitrary
  // 1000px unrelated to how many columns this chart actually has, and would force a chart
  // with only a couple of columns wider than its own minimum-readable-bar-width math ever
  // asks for, leaving dead space down both sides instead of the bars filling the frame.
  const { width: frameWidth, height: frameHeight } = resolveFrameSize(data, defaultWidth, 1040, defaultWidth)
  const availWidth = frameWidth - paddingLeft - paddingRight
  const colWidth = Math.round(Math.min(maxColWidth, availWidth / (colCount + (colCount - 1) * colGapRatio)))
  const colGap = Math.round(colWidth * colGapRatio)
  const contentWidth = colCount * colWidth + (colCount - 1) * colGap

  const frame = figma.createFrame()
  frame.resize(frameWidth, frameHeight)
  frame.name = 'Chart'
  frame.fills = [] // Transparent by default so the chart drops onto any background.
  // Never clip: even though height always comes from content now, this stays as a safety
  // net so nothing is ever silently cropped — better to overflow visibly than to lose a
  // bar, axis, or half a circle.
  frame.clipsContent = false
  frame.layoutMode = 'NONE'

  const maxVal = Math.max(...entries.map(e => e.value))
  const scaleArea = frameHeight - paddingTop - paddingBottom
  const nice = niceScale(maxVal, 8)
  const scale = nice.max > 0 ? scaleArea / nice.max : 1

  // Dashed gridlines + left-hand axis labels
  for (let i = 0; i < nice.ticks.length; i++) {
    const v = nice.ticks[i]
    const y = paddingTop + (nice.max - v) * scale
    const tick = figma.createLine()
    tick.resize(frameWidth - paddingLeft - paddingRight, 0)
    tick.x = paddingLeft
    tick.y = Math.round(y)
    tick.strokes = [ solidPaint(theme.grid) ]
    tick.strokeWeight = 1
    try { (tick as any).dashPattern = GRID_DASH } catch { }
    frame.appendChild(tick)

    const axisLbl = await createTextNode(formatAxisValue(v), MODERAT_REGULAR, TICK_FONT_SIZE, theme.text)
    axisLbl.name = 'y-axis-label'
    axisLbl.textAlignHorizontal = 'RIGHT'
    axisLbl.x = paddingLeft - 24 - (axisLbl.width || 0)
    // Center on the actual rendered box, not an assumed fontSize — the font's own line
    // height can be taller than the point size, which would otherwise throw the number off
    // its gridline by a few px.
    axisLbl.y = Math.round(y - (axisLbl.height || TICK_FONT_SIZE) / 2)
    frame.appendChild(axisLbl)
  }
  await addCartesianAxes(frame, theme, paddingLeft, paddingTop, frameWidth - paddingLeft - paddingRight, scaleArea)

  const barColor = normalizeColor(data.barColor, RED_NORTH)
  const startX = paddingLeft + Math.max(0, (availWidth - contentWidth) / 2)
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const h = Math.max(2, Math.round(e.value * scale))
    const x = startX + i * (colWidth + colGap)
    const y = paddingTop + (scaleArea - h)

    const bar = createRect(colWidth, h, solidPaint(barColor))
    bar.x = x
    bar.y = y
    frame.appendChild(bar)

    const valTxt = await createValueLabel(e.value, VALUE_FONT_SIZE, theme.text)
    valTxt.x = x + Math.round((colWidth - (valTxt.width || 0)) / 2)
    valTxt.y = Math.max(0, y - 64)
    frame.appendChild(valTxt)

    const lbl = await createTextNode(e.label, MODERAT_REGULAR, TICK_LABEL_FONT_SIZE, theme.text)
    lbl.name = 'category-label'
    lbl.x = x + Math.round((colWidth - (lbl.width || 0)) / 2)
    lbl.y = paddingTop + scaleArea + 32
    frame.appendChild(lbl)
  }

  makeChartAdaptive(frame, paddingLeft, paddingRight, paddingTop, paddingBottom, frameWidth, frameHeight, paddingBottom)
  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  await figma.clientStorage.setAsync(CHART_DATA_KEY, data)
  placeNewChartFrame(frame)
  figma.notify('Chart created')
  return frame
}

function placeFrameAtViewport(frame: FrameNode) {
  try {
    const bounds = figma.viewport.bounds
    let x = bounds.x + (bounds.width - frame.width) / 2
    let y = bounds.y + (bounds.height - frame.height) / 2
    // Clamp so the frame stays inside the area currently on screen whenever it fits there
    x = Math.max(bounds.x, Math.min(x, bounds.x + Math.max(0, bounds.width - frame.width)))
    y = Math.max(bounds.y, Math.min(y, bounds.y + Math.max(0, bounds.height - frame.height)))
    frame.x = Math.round(x)
    frame.y = Math.round(y)
  } catch (e) {
    // ignore if viewport not available
  }
}

// A freshly created chart's container: whichever frame/slide the user currently has
// selected on the canvas — so long as it isn't one of this plugin's own chart frames
// (nesting a brand-new chart inside another chart would be a mistake, not a container
// pick). Selecting one of our own charts instead drives notifySelection into edit mode,
// so in practice this only ever matches a genuine slide/design frame the user is targeting.
function resolvePlacementContainer(): DeckPageNode | null {
  const sel = figma.currentPage.selection[0]
  if (sel && (sel.type === 'FRAME' || sel.type === 'SLIDE') && !sel.getPluginData(TOOL_ID)) {
    return sel as DeckPageNode
  }
  // Figma Slides: in single-slide view the slide on screen usually isn't "selected" at
  // all (figma.currentPage.selection stays empty just looking at it) — Slides tracks that
  // separately as the focused slide, which is what a chart should land inside instead of
  // falling through to the viewport fallback and being born loose outside any slide.
  if (figma.editorType === 'slides') {
    try {
      const focused = figma.currentPage.focusedSlide
      if (focused && !focused.getPluginData(TOOL_ID)) return focused
    } catch { }
  }
  return null
}

// Every draw* function's final step for a brand-new chart (edits reposition/reparent the
// result themselves afterward, so this is only ever reached on create). With a frame/slide
// selected, the chart is born inside it, centered on its box; otherwise it falls back to
// the previous behavior — centered on the current viewport, appended straight to the page.
function placeNewChartFrame(frame: FrameNode) {
  const container = resolvePlacementContainer()
  if (container) {
    container.appendChild(frame)
    // A plain child of an auto-layout frame/slide defaults to layoutPositioning 'AUTO' —
    // the layout engine then owns its size and position outright (this is what was
    // crushing charts down to a sliver width, mangling their text, on any slide/frame
    // that happens to use auto-layout). 'ABSOLUTE' opts back out of that flow so the chart
    // keeps the exact size it was drawn at and manual x/y centering actually sticks.
    try { if (container.layoutMode !== 'NONE') frame.layoutPositioning = 'ABSOLUTE' } catch { }
    // Dead center is deterministic — a container that already holds one or more of this
    // plugin's own charts would otherwise get every new one stacked exactly on top of the
    // last (identical text/axes overlapping into an unreadable mess), so each existing
    // chart already inside nudges this one further down-right instead.
    const existingCharts = container.children.filter(c => c !== frame && c.getPluginData(TOOL_ID)).length
    const CASCADE_OFFSET = 32
    frame.x = Math.round((container.width - frame.width) / 2) + existingCharts * CASCADE_OFFSET
    frame.y = Math.round((container.height - frame.height) / 2) + existingCharts * CASCADE_OFFSET
  } else {
    placeFrameAtViewport(frame)
    figma.currentPage.appendChild(frame)
  }
  figma.currentPage.selection = [frame]
}

// UI and message handling
figma.showUI(__html__, { width: 420, height: 680 })

// Reads the current selection and tells the UI what to show.
// - If a chart frame is selected: switch the UI into "edit" mode for it.
// - If nothing selected / not a chart: tell the UI to go back to "create" mode.
function notifySelection() {
  const sel = figma.currentPage.selection[0]
  if (sel && sel.type === 'FRAME') {
    const pd = sel.getPluginData(TOOL_ID)
    if (pd) {
      try {
        const params = JSON.parse(pd)
        figma.ui.postMessage({ type: 'selection', params, frameId: sel.id })
        return
      } catch { /* fall through to "no selection" below */ }
    }
  }
  figma.ui.postMessage({ type: 'selection', params: null, frameId: null })
}

// Notify UI whenever the user clicks a different node on the canvas
figma.on('selectionchange', notifySelection)
// Also check immediately on open, in case a chart was already selected
notifySelection()

// A "page" (frame in Figma Design/FigJam; slide in Slides/Buzz) — used by
// resolvePlacementContainer/placeNewChartFrame to recognize whatever the user currently has
// selected/focused as a valid drop target for a freshly created chart.
type DeckPageNode = FrameNode | SlideNode

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'request-selection') {
    notifySelection()
    return
  }

  if (msg.type === 'clear-editing') {
    // User asked to start a new chart while keeping the old one selected
    figma.currentPage.selection = []
    figma.ui.postMessage({ type: 'selection', params: null, frameId: null })
    return
  }

  if (msg.type === 'run') {
    const params: ChartData = {
      chartType: msg.chartType || DEFAULTS.chartType,
      data: msg.data || DEFAULTS.data,
      barColor: normalizeColor(msg.barColor, RED_NORTH),
      overlapped: !!msg.overlapped,
      theme: msg.theme === 'dark' ? 'dark' : 'light',
      granularity: msg.granularity === 'week' || msg.granularity === 'monthly' ? msg.granularity : 'biweekly',
      vatIncluded: !!msg.vatIncluded,
      vatShowTotal: !!msg.vatShowTotal,
      tableColumns: typeof msg.tableColumns === 'string' ? msg.tableColumns : undefined,
    }

    // if editing an existing frame
    if (msg.editingFrameId) {
      const node = await figma.getNodeByIdAsync(msg.editingFrameId as string) as SceneNode | null
      if (!node || node.type !== 'FRAME') { figma.notify('Selected node not editable'); return }
      const oldX = node.x, oldY = node.y
      // x/y are relative to whatever the frame's parent is (the page itself, but just as
      // often a Section/Group/Frame the user organized their charts inside). Every draw*
      // function below appends its new frame straight to the page, so if the old frame
      // actually lived somewhere else, its parent + child index need to be restored too —
      // otherwise the old local x/y get reapplied in the wrong coordinate space and the
      // chart visibly jumps elsewhere on the canvas instead of updating in place.
      const oldParent = node.parent
      const oldIndex = oldParent ? oldParent.children.indexOf(node) : -1
      // A manual width resize on the canvas takes priority over the chart's own computed
      // default width, so redrawing an edited chart doesn't snap it back to a "fresh" size.
      // Height is deliberately not preserved this way — it always comes from content (see
      // resolveFrameSize) so an update never leaves the chart squashed inside a stale frame.
      params.requestedWidth = node.width
      // Draw the replacement BEFORE touching the old frame: if the redraw fails (e.g. empty
      // data) the original chart is left untouched instead of being deleted with nothing to
      // replace it — and since the new frame is positioned at the old one's exact x/y before
      // the old one is removed, the chart never visibly moves or disappears mid-edit, no
      // matter what changed (chart type, color, data, anything).
      let newFrame: FrameNode | null = null
      if (params.chartType === 'vertical') newFrame = await drawVerticalChart(params)
      else if (params.chartType === 'horizontal') newFrame = await drawHorizontalChart(params)
      else if (params.chartType === 'line' || params.chartType === 'multiline') newFrame = await drawMultiLineChart(params)
      else if (params.chartType === 'grouped') newFrame = await drawGroupedChart(params)
      else if (params.chartType === 'radar') newFrame = await drawRadarChart(params)
      else if (params.chartType === 'pie') newFrame = await drawPieChart(params)
      else if (params.chartType === 'donut') newFrame = await drawDonutChart(params)
      else if (params.chartType === 'progress') newFrame = await drawProgressChart(params)
      else if (params.chartType === 'timeline') newFrame = await drawTimelineChart(params)
      else if (params.chartType === 'budget') newFrame = await drawBudgetChart(params)
      else if (params.chartType === 'table') newFrame = await drawTableChart(params)
      else if (params.chartType === 'kpi') newFrame = await drawKpiChart(params)
      else if (params.chartType === 'funnel') newFrame = await drawFunnelChart(params)
      else if (params.chartType === 'network') newFrame = await drawForceGraphChart(params)
      else if (params.chartType === 'petals') newFrame = await drawPetalRoseChart(params)
      else if (params.chartType === 'tree') newFrame = await drawTreeChart(params)
      if (newFrame) {
        // Move it back into the old frame's actual parent (Section/Group/Frame/page) at the
        // same child index before applying x/y, so those coordinates land in the right space
        // and the stacking order relative to sibling layers is preserved too.
        if (oldParent) {
          try { oldParent.insertChild(Math.max(0, oldIndex), newFrame) }
          catch { try { oldParent.appendChild(newFrame) } catch { } }
        }
        // keep the chart exactly where the old one was, regardless of what changed
        try { newFrame.x = oldX; newFrame.y = oldY } catch { }
        try { node.remove() } catch { }
        figma.currentPage.selection = [newFrame]
        figma.notify('Chart updated')
      } else {
        figma.notify('Update failed — original chart kept')
      }
      // Sent only after the old frame is fully gone and the new one fully placed.
      figma.ui.postMessage({ type: 'run-complete', chartType: params.chartType, wasEditing: true })
      return
    }

    // normal create
    if (params.chartType === 'vertical') await drawVerticalChart(params)
    else if (params.chartType === 'horizontal') await drawHorizontalChart(params)
    else if (params.chartType === 'line' || params.chartType === 'multiline') await drawMultiLineChart(params)
    else if (params.chartType === 'grouped') await drawGroupedChart(params)
    else if (params.chartType === 'radar') await drawRadarChart(params)
    else if (params.chartType === 'pie') await drawPieChart(params)
    else if (params.chartType === 'donut') await drawDonutChart(params)
    else if (params.chartType === 'progress') await drawProgressChart(params)
    else if (params.chartType === 'timeline') await drawTimelineChart(params)
    else if (params.chartType === 'budget') await drawBudgetChart(params)
    else if (params.chartType === 'table') await drawTableChart(params)
    else if (params.chartType === 'kpi') await drawKpiChart(params)
    else if (params.chartType === 'funnel') await drawFunnelChart(params)
    else if (params.chartType === 'network') await drawForceGraphChart(params)
    else if (params.chartType === 'petals') await drawPetalRoseChart(params)
    else if (params.chartType === 'tree') await drawTreeChart(params)
    else figma.notify('Only vertical and horizontal charts are implemented in this build')
    figma.ui.postMessage({ type: 'run-complete', chartType: params.chartType, wasEditing: false })
  } else if (msg.type === 'resize' && typeof msg.height === 'number') {
    const width = typeof msg.width === 'number' ? Math.max(320, Math.min(900, Math.round(msg.width))) : 420
    // Floor of 40 (rather than the usual ~120) so the UI can collapse down to just its
    // header bar; normal (expanded) heights never request anything that low anyway.
    figma.ui.resize(width, Math.max(40, Math.min(900, Math.ceil(msg.height))))
  }
}

// Parses "label: v1|v2|v3|..." into an arbitrary number of series per row (used by
// multiline, grouped, and progress). Every row is padded to the longest row's series
// count so all series draw with the same number of points.
function parseMultiSeries(str: string): { label: string; values: number[] }[] {
  const out: { label: string; values: number[] }[] = []
  for (const part of str.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const colonIdx = trimmed.indexOf(':')
    const toValues = (valPart: string) => valPart.split('|').map(v => {
      const n = Number(v.trim())
      return !isNaN(n) && n >= 0 ? n : 0
    })
    if (colonIdx > 0) {
      const label = trimmed.slice(0, colonIdx).trim()
      out.push({ label, values: toValues(trimmed.slice(colonIdx + 1).trim()) })
    } else {
      out.push({ label: String(out.length + 1), values: toValues(trimmed) })
    }
  }
  const maxLen = Math.max(1, ...out.map(r => r.values.length))
  for (const r of out) while (r.values.length < maxLen) r.values.push(0)
  return out
}

// Line and multi-line are unified: this draws 1+ lines the same way, so a plain "line"
// chart is just this with a single row.
async function drawMultiLineChart(data: ChartData): Promise<FrameNode | null> {
  // Each row is one whole line: its label is the line's name (legend), and its values are
  // the sequential points along the shared x-axis.
  const lines = parseMultiSeries(data.data)
  if (!lines.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)
  const lineCount = lines.length
  const pointCount = lines[0].values.length
  const paddingLeft = 150, paddingRight = 90
  // More lines need more vertical room for their value labels, which fan out further
  // above/below the line the more lines share the chart.
  const extraPadding = Math.max(0, lineCount - 2) * 28
  const paddingTop = 220 + extraPadding, paddingBottom = 180 + extraPadding
  const defaultWidth = paddingLeft + paddingRight + (pointCount - 1) * 140 + 300
  const defaultHeight = 1040 + extraPadding * 2
  const { width: w, height: h } = resolveFrameSize(data, defaultWidth, defaultHeight, MIN_LINE_CHART_WIDTH, MAX_LINE_CHART_WIDTH)
  const frame = figma.createFrame()
  frame.resize(w, h)
  frame.fills = [] // Transparent by default so the chart drops onto any background.
  // Never clip: even though height always comes from content now, this stays as a safety
  // net so nothing is ever silently cropped — better to overflow visibly than to lose a
  // bar, axis, or half a circle.
  frame.clipsContent = false
  frame.name = 'Chart'

  const maxVal = Math.max(...lines.map(l => Math.max(...l.values)))
  const areaW = w - paddingLeft - paddingRight, areaH = h - paddingTop - paddingBottom
  const nice = niceScale(maxVal, 8)
  const scale = nice.max > 0 ? areaH / nice.max : 1

  for (let i = 0; i < nice.ticks.length; i++) {
    const v = nice.ticks[i]
    const y = paddingTop + (nice.max - v) * scale
    const line = figma.createLine()
    line.name = 'h-gridline'
    line.resize(areaW, 0)
    line.x = paddingLeft
    line.y = Math.round(y)
    line.strokes = [ solidPaint(theme.grid) ]
    line.strokeWeight = 1
    try { (line as any).dashPattern = GRID_DASH } catch { }
    frame.appendChild(line)
    const lbl = await createTextNode(formatAxisValue(v), MODERAT_REGULAR, TICK_FONT_SIZE, theme.text)
    lbl.name = 'y-axis-label'
    lbl.textAlignHorizontal = 'RIGHT'
    lbl.x = paddingLeft - 24 - (lbl.width || 0)
    lbl.y = Math.round(y - (lbl.height || TICK_FONT_SIZE) / 2)
    frame.appendChild(lbl)
  }
  await addCartesianAxes(frame, theme, paddingLeft, paddingTop, areaW, areaH)

  const barColor = normalizeColor(data.barColor, RED_NORTH)
  const lineColors = lineChartColors(barColor, lineCount, theme)
  const linePts = lines.map(l => l.values.map((v, i) => ({
    x: paddingLeft + Math.round(i * (areaW / Math.max(1, pointCount - 1))),
    y: paddingTop + (nice.max - v) * scale,
  })))

  // Draw back-to-front so line 0 (the thickest, most prominent line) ends up on top.
  for (let s = lineCount - 1; s >= 0; s--) {
    const poly = await makeVectorPolyline(linePts[s], lineColors[s], s === 0 ? 6 : 4)
    frame.appendChild(poly)
  }
  for (let s = lineCount - 1; s >= 0; s--) {
    const size = s === 0 ? 18 : 15
    for (const p of linePts[s]) {
      frame.appendChild(createAnchoredDot(p.x, p.y, size, lineColors[s]))
    }
  }

  // Whether a point's label defaults above or below its point: a local peak (higher than
  // both neighbors) gets pushed above, into the open space past the peak instead of where
  // the line dips back down on either side; a local valley gets pushed below for the same
  // reason. A point on a flat/monotonic stretch has no natural "outside" of the line to
  // prefer, so it alternates by index instead — otherwise a long ascending/descending run
  // would stack every label on the same side, on top of each other and of the line itself.
  const isPeak = (pts: { x: number; y: number }[], i: number) =>
    (i === 0 || pts[i].y <= pts[i - 1].y) && (i === pts.length - 1 || pts[i].y <= pts[i + 1].y)
  const isValley = (pts: { x: number; y: number }[], i: number) =>
    (i === 0 || pts[i].y >= pts[i - 1].y) && (i === pts.length - 1 || pts[i].y >= pts[i + 1].y)
  const defaultAbove = (pts: { x: number; y: number }[], i: number) =>
    isPeak(pts, i) ? true : isValley(pts, i) ? false : i % 2 === 0

  // Value labels sit right on their own point (horizontally centered — except the very
  // first/last point, clamped inside the plot area so it can't cross the axis or spill off
  // the edge), in that line's color, above or below per defaultAbove(). At an x-index,
  // points close enough together that their labels could collide are grouped into a
  // cluster (adjacent in y-sorted order, each within LABEL_GAP of the next) and, within
  // that cluster, side is decided purely by vertical order — topmost point above, next
  // below, next above again but stepped out further, and so on — instead of each line's
  // own peak/valley preference, since two points assigned by shape alone can still land on
  // opposite sides that cross through each other when the points themselves are this close
  // (a "below" label hanging under a slightly-higher point can still overlap an "above"
  // label sitting on top of a slightly-lower one). A lone, uncontested point keeps its own
  // shape-based preference as before.
  const LABEL_GAP = 70
  const LABEL_STEP = 58
  for (let i = 0; i < pointCount; i++) {
    const order = Array.from({ length: lineCount }, (_, s) => s).sort((a, b) => linePts[a][i].y - linePts[b][i].y)
    const clusters: number[][] = []
    for (const s of order) {
      const last = clusters[clusters.length - 1]
      if (last && Math.abs(linePts[s][i].y - linePts[last[last.length - 1]][i].y) < LABEL_GAP) last.push(s)
      else clusters.push([s])
    }
    for (const cluster of clusters) {
      for (let k = 0; k < cluster.length; k++) {
        const s = cluster[k]
        const p = linePts[s][i]
        const above = cluster.length === 1 ? defaultAbove(linePts[s], i) : k % 2 === 0
        const rank = cluster.length === 1 ? 0 : Math.floor(k / 2)
        const vt = await createValueLabel(lines[s].values[i], LINE_VALUE_FONT_SIZE, lineColors[s], NOE_REGULAR, LINE_VALUE_SUFFIX_SIZE)
        const labelW = vt.width || 0
        vt.x = clamp(p.x - Math.round(labelW / 2), paddingLeft, w - paddingRight - labelW)
        vt.y = above ? p.y - 64 - rank * LABEL_STEP : p.y + 20 + rank * LABEL_STEP
        frame.appendChild(vt)
      }
    }
  }

  // legend — each line's own name, sitting just below the chart's own axis line (not way
  // down near the frame's bottom edge) so it visually stays attached to the grid it labels.
  const legendRow = await createLegendRow(lines.map((l, s) => ({ color: lineColors[s], label: l.label })), theme)
  legendRow.x = paddingLeft
  legendRow.y = paddingTop + areaH + 55
  frame.appendChild(legendRow)

  makeChartAdaptive(frame, paddingLeft, paddingRight, paddingTop, paddingBottom, w, h)
  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify('Line chart created')
  return frame
}

async function drawGroupedChart(data: ChartData): Promise<FrameNode | null> {
  const rows = parseMultiSeries(data.data)
  if (!rows.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)
  const seriesCount = rows[0].values.length
  const overlapped = !!data.overlapped
  const paddingLeft = 150, paddingRight = 90, paddingTop = 220, paddingBottom = 180
  const pairGap = overlapped ? 0 : 12
  const rowCount = rows.length
  // Bars stretch to fill the full gridline width instead of leaving a gap: the frame
  // only grows past its minimum width once there are too many groups to fit at the
  // minimum readable bar width, growing all the way up to MAX_CHART_WIDTH before bars
  // start shrinking again to keep fitting.
  const groupGapRatio = 0.55
  const minBarWidth = overlapped ? 66 : 40
  const maxBarWidth = overlapped ? 190 : 95
  const toGroupWidth = (bw: number) => overlapped ? bw : (bw * seriesCount + pairGap * (seriesCount - 1))
  const minGroupWidth = toGroupWidth(minBarWidth)
  const maxGroupWidth = toGroupWidth(maxBarWidth)
  const neededWidth = rowCount * minGroupWidth + (rowCount - 1) * minGroupWidth * groupGapRatio
  const defaultWidth = paddingLeft + paddingRight + neededWidth
  // defaultWidth doubles as the floor — see drawVerticalChart's identical fix for why: the
  // shared MIN_CHART_WIDTH is unrelated to how many groups this chart has, and would force
  // a chart with only a couple of groups wider than its own minimum-readable-bar-width math
  // asks for, leaving dead space down both sides instead of the groups filling the frame.
  const { width: frameWidth, height: frameHeight } = resolveFrameSize(data, defaultWidth, 1040, defaultWidth)
  const availWidth = frameWidth - paddingLeft - paddingRight
  const fitGroupWidth = Math.min(maxGroupWidth, availWidth / (rowCount + (rowCount - 1) * groupGapRatio))
  const barWidth = Math.round(overlapped ? fitGroupWidth : (fitGroupWidth - pairGap * (seriesCount - 1)) / seriesCount)
  const groupWidth = toGroupWidth(barWidth)
  const groupGap = Math.round(groupWidth * groupGapRatio)
  const contentWidth = rowCount * groupWidth + (rowCount - 1) * groupGap
  const frame = figma.createFrame()
  frame.resize(frameWidth, frameHeight)
  frame.fills = [] // Transparent by default so the chart drops onto any background.
  // Never clip: even though height always comes from content now, this stays as a safety
  // net so nothing is ever silently cropped — better to overflow visibly than to lose a
  // bar, axis, or half a circle.
  frame.clipsContent = false
  frame.name = 'Chart'

  const scaleAreaTop = paddingTop, scaleAreaBottom = frameHeight - paddingBottom
  const scaleArea = scaleAreaBottom - scaleAreaTop
  const maxVal = overlapped
    ? Math.max(...rows.map(r => r.values.reduce((a, b) => a + b, 0)))
    : Math.max(...rows.map(r => Math.max(...r.values)))
  const nice = niceScale(maxVal, 8)
  const scale = nice.max > 0 ? scaleArea / nice.max : 1

  for (let i = 0; i < nice.ticks.length; i++) {
    const v = nice.ticks[i]
    const y = scaleAreaTop + (nice.max - v) * scale
    const line = figma.createLine()
    line.resize(frameWidth - paddingLeft - paddingRight, 0)
    line.x = paddingLeft
    line.y = Math.round(y)
    line.strokes = [ solidPaint(theme.grid) ]
    line.strokeWeight = 1
    try { (line as any).dashPattern = GRID_DASH } catch { }
    frame.appendChild(line)
    const lbl = await createTextNode(formatAxisValue(v), MODERAT_REGULAR, TICK_FONT_SIZE, theme.text)
    lbl.name = 'y-axis-label'
    lbl.textAlignHorizontal = 'RIGHT'
    lbl.x = paddingLeft - 24 - (lbl.width || 0)
    lbl.y = Math.round(y - (lbl.height || TICK_FONT_SIZE) / 2)
    frame.appendChild(lbl)
  }
  await addCartesianAxes(frame, theme, paddingLeft, scaleAreaTop, frameWidth - paddingLeft - paddingRight, scaleArea)

  const barColor = normalizeColor(data.barColor, RED_NORTH)
  const seriesColors = seriesColorsLight(barColor, seriesCount, theme.bg)
  const startX = paddingLeft + Math.max(0, (availWidth - contentWidth) / 2)
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const gx = startX + i * (groupWidth + groupGap)
    if (overlapped) {
      // Stack back-to-front (series N-1 at the bottom) so series 0 ends up on top.
      let cumH = 0
      for (let s = seriesCount - 1; s >= 0; s--) {
        const hS = Math.max(0, Math.round(r.values[s] * scale))
        const seg = createRect(barWidth, hS, solidPaint(seriesColors[s]))
        seg.x = gx; seg.y = scaleAreaBottom - cumH - hS
        frame.appendChild(seg)
        cumH += hS
      }

      // Total value above the stack, same convention as a plain (non-overlapped) bar chart.
      const total = r.values.reduce((a, b) => a + b, 0)
      const valTxt = await createValueLabel(total, VALUE_FONT_SIZE, theme.text)
      valTxt.x = gx + Math.round((barWidth - (valTxt.width || 0)) / 2)
      valTxt.y = Math.max(0, scaleAreaBottom - cumH - 64)
      frame.appendChild(valTxt)
    } else {
      for (let s = 0; s < seriesCount; s++) {
        const hS = Math.max(2, Math.round(r.values[s] * scale))
        const seg = createRect(barWidth, hS, solidPaint(seriesColors[s]))
        seg.x = gx + s * (barWidth + pairGap)
        seg.y = scaleAreaBottom - hS
        frame.appendChild(seg)
      }
    }
    const lbl = await createTextNode(r.label, MODERAT_REGULAR, TICK_LABEL_FONT_SIZE, theme.text)
    lbl.name = 'category-label'
    lbl.x = gx + Math.round((groupWidth - (lbl.width || 0)) / 2)
    lbl.y = scaleAreaBottom + 32
    frame.appendChild(lbl)
  }

  // legend
  const legendItems = Array.from({ length: seriesCount }, (_, s) => ({ color: seriesColors[s], label: 'Series ' + (s + 1) }))
  const legendRow = await createLegendRow(legendItems, theme)
  legendRow.x = paddingLeft
  legendRow.y = frameHeight - 60
  frame.appendChild(legendRow)

  makeChartAdaptive(frame, paddingLeft, paddingRight, paddingTop, paddingBottom, frameWidth, frameHeight, paddingBottom)
  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify(overlapped ? 'Stacked chart created' : 'Grouped chart created')
  return frame
}

async function drawRadarChart(data: ChartData): Promise<FrameNode | null> {
  const rows = parseData(data.data)
  if (!rows.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)
  const padding = 150
  const labelPad = 60
  const defaultSize = 1045
  const { width: size, height: frameHeight } = resolveFrameSize(data, defaultSize, defaultSize + labelPad * 2)
  const center = size / 2
  const frame = figma.createFrame()
  frame.resize(size, frameHeight)
  frame.fills = [] // Transparent by default so the chart drops onto any background.
  // Never clip: even though height always comes from content now, this stays as a safety
  // net so nothing is ever silently cropped — better to overflow visibly than to lose a
  // bar, axis, or half a circle.
  frame.clipsContent = false
  frame.name = 'Chart'

  const cy = frameHeight / 2
  const maxVal = Math.max(...rows.map(r => r.value)) || 1
  const radius = Math.min(center, frameHeight / 2) - padding
  const barColor = normalizeColor(data.barColor, RED_NORTH)
  const webColor = theme.grid

  // 1. Dibujar la cuadrícula del radar (varios anillos concéntricos)
  const niveles = 4
  for (let nivel = 1; nivel <= niveles; nivel++) {
    const radioActual = radius * (nivel / niveles)
    const ringPts = rows.map((r, i) => {
      const ang = (Math.PI * 2) * (i / rows.length) - Math.PI / 2
      return { x: center + Math.cos(ang) * radioActual, y: cy + Math.sin(ang) * radioActual }
    })
    const ring = await makeVectorPolyline([...ringPts, ringPts[0]], webColor, 1)
    frame.appendChild(ring)
  }

  // 2. Dibujar las líneas radiales (desde el centro hacia los bordes)
  for (let i = 0; i < rows.length; i++) {
    const ang = (Math.PI * 2) * (i / rows.length) - Math.PI / 2
    const rLine = await makeVectorPolyline([
      { x: center, y: cy },
      { x: center + Math.cos(ang) * radius, y: cy + Math.sin(ang) * radius }
    ], webColor, 1)
    frame.appendChild(rLine)
  }

  // 3. Calcular los puntos de los datos
  const polyPts = rows.map((r, i) => {
    const ang = (Math.PI * 2) * (i / rows.length) - Math.PI / 2
    const rad = radius * (r.value / maxVal)
    return { x: center + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad }
  })

  // 4. Dibujar el polígono de datos con relleno translúcido y borde
  const fillColor = { ...barColor, a: 0.2 } // Mismo color, pero 20% de opacidad
  const poly = await makeVectorPolygon(polyPts, fillColor)
  poly.strokes = [solidPaint(barColor)]
  poly.strokeWeight = 2
  frame.appendChild(poly)

  // 5. Dibujar los puntos (dots) en los vértices
  for (const p of polyPts) {
    const dot = figma.createEllipse()
    dot.resize(22, 22) // Tamaño del punto
    dot.x = p.x - 11  // Centrado en el vértice
    dot.y = p.y - 11
    dot.fills = [solidPaint(barColor)]
    dot.strokes = [solidPaint(theme.bg)] // Borde que se funde con el fondo
    dot.strokeWeight = 2
    frame.appendChild(dot)
  }

  for (let i = 0; i < rows.length; i++) {
    const ang = (Math.PI * 2) * (i / rows.length) - Math.PI / 2
    const lx = center + Math.cos(ang) * (radius + labelPad)
    const ly = cy + Math.sin(ang) * (radius + labelPad)
    const lbl = await createTextNode(rows[i].label, MODERAT_REGULAR, TICK_LABEL_FONT_SIZE, theme.text)
    lbl.x = Math.round(lx - (lbl.width || 0) / 2)
    lbl.y = Math.round(ly - TICK_LABEL_FONT_SIZE / 2)
    frame.appendChild(lbl)
  }

  makeUniformScaleAdaptive(frame, size, frameHeight)
  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify('Radar chart created')
  return frame
}

async function drawPieChart(data: ChartData): Promise<FrameNode | null> {
  const entries = parseData(data.data)
  if (!entries.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)
  const size = 770
  const topOffset = 100
  const outerR = size * 0.42
  const labelR = outerR + 95
  // Half-width is driven by the farthest thing that gets drawn (the label ring, plus
  // room for the label text itself) so the circle sits exactly on the frame's center
  // line instead of using fixed, asymmetric side margins.
  const half = Math.round(labelR + 140)
  const defaultWidth = half * 2
  const { width: frameWidth, height: frameHeight } = resolveFrameSize(data, defaultWidth, size + topOffset + 100)
  const cx = frameWidth / 2
  // Centered on whatever height the frame actually ends up at (its own default, or a
  // preserved manual size from editing) rather than a fixed offset from the top — so the
  // circle stays visually centered instead of drifting toward one edge.
  const cy = frameHeight / 2
  const frame = figma.createFrame()
  frame.resize(frameWidth, frameHeight)
  frame.fills = [] // Transparent by default so the chart drops onto any background.
  // Never clip: even though height always comes from content now, this stays as a safety
  // net so nothing is ever silently cropped — better to overflow visibly than to lose a
  // bar, axis, or half a circle.
  frame.clipsContent = false
  frame.name = 'Chart'

  const total = entries.reduce((s, e) => s + e.value, 0)
  let angleAcc = -Math.PI / 2
  const barColor = normalizeColor(data.barColor, RED_NORTH)
  const colors = seriesColorsLight(barColor, entries.length, theme.bg)

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const portion = total > 0 ? e.value / total : 0
    const angle = portion * Math.PI * 2
    const slices = Math.max(6, Math.round(angle / (Math.PI * 2) * 64))
    const outerPts: { x: number; y: number }[] = []
    for (let s = 0; s <= slices; s++) {
      const a = angleAcc + (s / slices) * angle
      outerPts.push({ x: cx + Math.cos(a) * outerR, y: cy + Math.sin(a) * outerR })
    }
    const polyPts = [{ x: cx, y: cy }].concat(outerPts)
    const slice = await makeVectorPolygon(polyPts, colors[i], theme.bg)
    frame.appendChild(slice)

    const midAngle = angleAcc + angle / 2
    const lx = cx + Math.cos(midAngle) * labelR
    const ly = cy + Math.sin(midAngle) * labelR
    const valTxt = await createValueLabel(e.value, VALUE_FONT_SIZE, theme.text)
    valTxt.x = Math.round(lx - (valTxt.width || 0) / 2)
    valTxt.y = Math.round(ly - 44)
    frame.appendChild(valTxt)
    const idxTxt = await createTextNode(e.label, MODERAT_REGULAR, TICK_LABEL_FONT_SIZE, theme.text)
    idxTxt.x = Math.round(lx - (idxTxt.width || 0) / 2)
    idxTxt.y = Math.round(ly)
    frame.appendChild(idxTxt)

    angleAcc += angle
  }

  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify('Pie chart created')
  return frame
}

async function drawDonutChart(data: ChartData): Promise<FrameNode | null> {
  const entries = parseData(data.data)
  if (!entries.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)
  const size = 715
  const topOffset = 100
  const cx = size / 2
  const legendW = 480
  const defaultWidth = size + legendW
  const { width: frameWidth, height: frameHeight } = resolveFrameSize(data, defaultWidth, topOffset + size + 80)
  // Centered on whatever height the frame actually ends up at (its own default, or a
  // preserved manual size from editing) rather than a fixed offset from the top — so the
  // ring stays visually centered instead of drifting toward one edge.
  const cy = frameHeight / 2
  const frame = figma.createFrame()
  frame.resize(frameWidth, frameHeight)
  frame.fills = [] // Transparent by default so the chart drops onto any background.
  // Never clip: even though height always comes from content now, this stays as a safety
  // net so nothing is ever silently cropped — better to overflow visibly than to lose a
  // bar, axis, or half a circle.
  frame.clipsContent = false
  frame.name = 'Chart'

  const total = entries.reduce((s, e) => s + e.value, 0)
  let angleAcc = -Math.PI / 2
  const barColor = normalizeColor(data.barColor, RED_NORTH)
  const colors = seriesColorsLight(barColor, entries.length, theme.bg)
  const outerR = size * 0.46
  const innerR = size * 0.27

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const portion = total > 0 ? e.value / total : 0
    const angle = portion * Math.PI * 2
    const slices = Math.max(6, Math.round(angle / (Math.PI * 2) * 64))
    const outerPts: { x: number; y: number }[] = []
    const innerPts: { x: number; y: number }[] = []
    for (let s = 0; s <= slices; s++) {
      const a = angleAcc + (s / slices) * angle
      outerPts.push({ x: cx + Math.cos(a) * outerR, y: cy + Math.sin(a) * outerR })
      innerPts.push({ x: cx + Math.cos(a) * innerR, y: cy + Math.sin(a) * innerR })
    }
    innerPts.reverse()
    const vertices = outerPts.concat(innerPts)
    const vec = figma.createVector()
    const segs: any[] = []
    for (let k = 0; k < vertices.length; k++) segs.push({ start: k, end: (k + 1) % vertices.length })
    const outerLoop = outerPts.map((_, idx) => idx)
    const innerLoop = innerPts.map((_, idx) => outerPts.length + idx)
    await vec.setVectorNetworkAsync({ vertices, segments: segs, regions: [{ loops: [outerLoop, innerLoop], windingRule: 'NONZERO' }] } as any)
    vec.fills = [ solidPaint(colors[i]) ]
    vec.strokes = [ solidPaint(theme.bg) ]
    vec.strokeWeight = 4
    try { vec.strokeAlign = 'INSIDE' } catch { }
    frame.appendChild(vec)
    angleAcc += angle
  }

  const legendX = size + 90
  let legendY = topOffset + 10
  for (let i = 0; i < entries.length; i++) {
    const sw = figma.createEllipse()
    sw.resize(20, 20); sw.fills = [ solidPaint(colors[i]) ]; sw.x = legendX; sw.y = legendY + 4; frame.appendChild(sw)
    const lt = await createTextNode(entries[i].label.toUpperCase(), MODERAT_MEDIUM, TICK_LABEL_FONT_SIZE, theme.text)
    lt.x = legendX + 32; lt.y = legendY; frame.appendChild(lt)
    // The raw value (not a manufactured "%"), since input values aren't necessarily
    // percentages — the slice angles above already encode each entry's true share of total.
    const valTxt = await createValueLabel(entries[i].value, VALUE_FONT_SIZE, colors[i], NOE_BOLD)
    valTxt.x = legendX + 260; valTxt.y = legendY - 8; frame.appendChild(valTxt)
    legendY += 72
  }

  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify('Donut chart created')
  return frame
}

async function drawProgressChart(data: ChartData): Promise<FrameNode | null> {
  const rows = parseMultiSeries(data.data)
  if (!rows.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)
  const seriesCount = rows[0].values.length
  const overlapped = !!data.overlapped
  const paddingX = 90
  const rowH = 90, rowGap = 24, blockGap = 95
  const headerH = 75
  const blockH = overlapped ? (headerH + rowH) : (headerH + seriesCount * rowH + (seriesCount - 1) * rowGap)
  const defaultHeight = 220 + rows.length * blockH + (rows.length - 1) * blockGap + 66
  const { width: w, height: h } = resolveFrameSize(data, 1200, defaultHeight)
  const frame = figma.createFrame()
  frame.resize(w, h)
  frame.fills = [] // Transparent by default so the chart drops onto any background.
  // Never clip: even though height always comes from content now, this stays as a safety
  // net so nothing is ever silently cropped — better to overflow visibly than to lose a
  // bar, axis, or half a circle.
  frame.clipsContent = false
  frame.name = 'Chart'

  const trackWidth = w - paddingX * 2
  // 100% of the track is the largest value anywhere in the chart (any row, any series) —
  // so every bar's length reads as its true share of that biggest number, and the block
  // holding it scales down accordingly, instead of each row filling its own track
  // independently regardless of how small its actual value is next to the others.
  const maxVal = Math.max(...rows.flatMap(r => r.values), 1)
  const barColor = normalizeColor(data.barColor, RED_NORTH)
  const seriesColors = seriesColorsLight(barColor, seriesCount, theme.bg)

  let y = 220
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const labelTxt = await createTextNode(r.label, MODERAT_MEDIUM, TICK_LABEL_FONT_SIZE, theme.text)
    labelTxt.x = paddingX; labelTxt.y = y; frame.appendChild(labelTxt)

    // "vs anterior" always compares series 0 (current) against series 1 (previous) —
    // that comparison stays meaningful no matter how many extra series are added.
    if (seriesCount >= 2) {
      const diff = r.values[0] - r.values[1]
      const pct = r.values[1] !== 0 ? Math.round((diff / r.values[1]) * 100) : (r.values[0] > 0 ? 100 : 0)
      const sign = diff >= 0 ? '+' : ''
      const changeColor = diff >= 0 ? GREEN_TEXT : barColor
      const changeTxt = await createTextNode(`${sign}${diff} / ${sign}${pct}% vs anterior`, MODERAT_MEDIUM, 18, changeColor)
      changeTxt.x = w - paddingX - (changeTxt.width || 0); changeTxt.y = y + 4; frame.appendChild(changeTxt)
    }

    // A 0 value renders fully collapsed rather than a fake stub bar; anything above 0 draws
    // at its true proportional width, however small next to the chart's largest value —
    // placeProgressValueLabel already falls back to printing the number just past the bar
    // instead of inside it once that width can't fit the label, so a tiny sliver never
    // clips or hides its own value. Widths are clamped to the track so nothing overflows it.
    const fillWidths = r.values.map(v => v > 0 ? Math.min(trackWidth, Math.round((v / maxVal) * trackWidth)) : 0)
    const rowY = y + headerH

    if (overlapped) {
      const track = createRect(trackWidth, rowH, solidPaint(theme.track))
      track.x = paddingX; track.y = rowY; frame.appendChild(track)

      // All bars share the same track and origin — their widths are scaled
      // independently (never added together). The widest is drawn first as the
      // background layer, then narrower ones on top so they always stay visible
      // instead of being hidden underneath.
      const bars = fillWidths.map((fw, s) => ({ w: fw, color: seriesColors[s] })).sort((a, b) => b.w - a.w)
      for (const bar of bars) {
        if (bar.w > 0) {
          const fill = createRect(bar.w, rowH, solidPaint(bar.color))
          fill.x = paddingX; fill.y = rowY; frame.appendChild(fill)
        }
      }

      await placeProgressValueLabel(frame, r.values[0], fillWidths[0], paddingX, rowY, rowH, theme.bg, seriesColors[0])
      // Always show every other series' label, even a small number fully covered by a
      // wider bar — just past its own (possibly tiny) sliver. When that position falls
      // inside a wider bar's still-colored region, use a contrasting color so it stays legible.
      for (let s = 1; s < seriesCount; s++) {
        const widerElsewhere = fillWidths.some((fw, idx) => idx !== s && fw >= fillWidths[s])
        const val = await createTextNode(String(r.values[s]), MODERAT_MEDIUM, 24, widerElsewhere ? theme.bg : seriesColors[s])
        val.x = paddingX + fillWidths[s] + 28; val.y = rowY + rowH / 2 - 12; frame.appendChild(val)
      }
    } else {
      for (let s = 0; s < seriesCount; s++) {
        const rY = rowY + s * (rowH + rowGap)
        const track = createRect(trackWidth, rowH, solidPaint(theme.track))
        track.x = paddingX; track.y = rY; frame.appendChild(track)
        if (fillWidths[s] > 0) {
          const fill = createRect(fillWidths[s], rowH, solidPaint(seriesColors[s]))
          fill.x = paddingX; fill.y = rY; frame.appendChild(fill)
        }
        await placeProgressValueLabel(frame, r.values[s], fillWidths[s], paddingX, rY, rowH, theme.bg, seriesColors[s])
      }
    }

    y += blockH + blockGap
  }

  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify(overlapped ? 'Overlapped progress chart created' : 'Progress chart created')
  return frame
}

const MONTH_NAMES_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(year, monthIndex0 + 1, 0).getDate()
}

interface TimelineRow { label: string; start: Date; end: Date; isPhase: boolean }
// Row format is tab-separated cells ("Label \t YYYY-MM-DD \t YYYY-MM-DD \t phase|task") per
// newline-separated row, in tree order (each phase immediately followed by its own
// subtasks) — NOT the shared comma/colon/pipe format the other chart types use, since a
// typed task label routinely contains a literal comma or colon ("Benchmark, análisis:
// competencia."), which would get misread as a row/field boundary under that format (the
// same reasoning behind Table's tab/newline format). Grouping is inferred purely from list
// order: a task row belongs to whichever phase row precedes it; a task with no preceding
// phase (e.g. legacy data from before this tree structure existed) still renders, just
// unindented, rather than being dropped.
function parseTimelineRows(str: string): TimelineRow[] {
  const out: TimelineRow[] = []
  for (const line of String(str || '').split('\n')) {
    if (!line.trim()) continue
    const cells = line.split('\t')
    const label = (cells[0] || '').trim() || String(out.length + 1)
    const start = new Date((cells[1] || '').trim() + 'T00:00:00')
    const end = new Date((cells[2] || '').trim() + 'T00:00:00')
    // end === start is a valid 1-day task (picking the same date for Start and End is the
    // natural way to represent that) — only reject if end is actually before start.
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end.getTime() < start.getTime()) continue
    out.push({ label, start, end, isPhase: (cells[3] || '').trim() === 'phase' })
  }
  return out
}

// Plain decimal amount, not formatValue's K/M-suffix shorthand — a price should always show
// its exact value ("2.420,00 €"), not a rounded-off approximation ("2.4K"). Spanish/European
// convention: "." thousands separator, "," decimal separator, trailing € symbol.
function formatCurrency(n: number): string {
  const rounded = Math.round(n * 100) / 100
  const [intPart, decPart] = rounded.toFixed(2).split('.')
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return withThousands + ',' + decPart + ' €'
}

// Budget/quote calculator: a bordered box listing service line items (label + pre-VAT
// price) with thin solid dividers between them, a TOTAL row below the box, and a small
// footnote noting VAT is separate (with the VAT-inclusive figure alongside it, so both the
// with- and without-VAT prices are available even though the box itself only ever totals
// the pre-VAT figure). Plain theme text throughout, no accent color — a neutral, invoice-like
// look. No resize-adaptation (like radar/pie/donut/progress) — a static frame is the
// simplest, safest default for a first version of a structurally different chart type.
async function drawBudgetChart(data: ChartData): Promise<FrameNode | null> {
  const entries = parseData(data.data)
  if (!entries.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)

  // VAT is a fixed 21% (Spain's standard rate) — not user-editable, so this never reads
  // from data.vatPercent.
  const vatPercent = 21
  const vatIncluded = !!data.vatIncluded
  const subtotal = entries.reduce((sum, e) => sum + e.value, 0)
  const vatAmount = subtotal * (vatPercent / 100)
  const totalWithVat = subtotal + vatAmount
  // The TOTAL row itself is whichever figure the toggle asks for — pre-VAT by default, or
  // the VAT-inclusive figure when "incluir IVA" is on — not just a footnote-level detail.
  const displayTotal = vatIncluded ? totalWithVat : subtotal

  const paddingX = 60, paddingTop = 50, paddingBottom = 50
  const boxPadX = 32
  // Vertical breathing room between the box's own top/bottom border and its first/last row
  // — without this, the box wrapped exactly around the rows with zero margin, so the first
  // row's text sat flush against the top border and the last row's flush against the bottom.
  const boxPadY = 28
  const ROW_H = 76
  const AFTER_BOX_GAP = 30
  const TOTAL_ROW_H = 48
  const FOOTNOTE_GAP = 14
  const FOOTNOTE_SIZE = 18

  const itemFontSize = TICK_LABEL_FONT_SIZE
  const totalFontSize = 34

  const boxHeight = boxPadY * 2 + entries.length * ROW_H
  const defaultHeight = paddingTop + boxHeight + AFTER_BOX_GAP + TOTAL_ROW_H + FOOTNOTE_GAP + FOOTNOTE_SIZE + paddingBottom
  const defaultWidth = 1100
  const { width: frameWidth, height: frameHeight } = resolveFrameSize(data, defaultWidth, defaultHeight)

  const frame = figma.createFrame()
  frame.resize(frameWidth, frameHeight)
  frame.name = 'Chart'
  frame.fills = []
  frame.clipsContent = false
  frame.layoutMode = 'NONE'

  const contentW = frameWidth - paddingX * 2

  // Bordered box, transparent inside — holds only the line items.
  const box = figma.createFrame()
  box.name = 'box'
  box.resize(Math.max(1, contentW), Math.max(1, boxHeight))
  box.x = paddingX
  box.y = paddingTop
  box.fills = []
  box.strokes = [solidPaint(theme.grid)]
  box.strokeWeight = 1
  try { box.cornerRadius = 4 } catch { }
  box.clipsContent = false
  frame.appendChild(box)

  let rowY = boxPadY
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const lbl = await createTextNode(e.label, MODERAT_REGULAR, itemFontSize, theme.text)
    lbl.x = boxPadX
    lbl.y = Math.round((ROW_H - (lbl.height || itemFontSize)) / 2)

    // "Incluir IVA" applies everywhere prices show up, not just the TOTAL row — every line
    // item's own price reflects VAT too when the toggle is on, so nothing on the chart is
    // left showing a pre-VAT figure next to a VAT-inclusive total.
    const itemValue = vatIncluded ? e.value * (1 + vatPercent / 100) : e.value
    const priceTxt = await createTextNode(formatCurrency(itemValue), NOE_REGULAR, itemFontSize, theme.text)
    priceTxt.x = Math.round(contentW - boxPadX - (priceTxt.width || 0))
    priceTxt.y = Math.round((ROW_H - (priceTxt.height || itemFontSize)) / 2)

    // Wrapped as a row-anchor (not appended directly) so live vertical resize can spread
    // rows out to fill a taller box (see makeBoxListAdaptive) without SCALE-distorting the
    // text nodes themselves.
    wrapRowInAnchor(box, [lbl, priceTxt], ['MIN', 'MAX'], 0, rowY, contentW, ROW_H)

    // Divider between items, not after the last one (the box border already closes it off).
    if (i < entries.length - 1) {
      const divider = await makeVectorPolyline([{ x: boxPadX, y: rowY + ROW_H }, { x: contentW - boxPadX, y: rowY + ROW_H }], theme.grid, 1)
      divider.name = 'row-divider'
      box.appendChild(divider)
    }
    rowY += ROW_H
  }

  // TOTAL — outside the box, plain bold text (no accent color). Pre-VAT by default; the
  // VAT-inclusive figure when the "incluir IVA" toggle is on.
  let curY = paddingTop + boxHeight + AFTER_BOX_GAP
  const totalLbl = await createTextNode('TOTAL', MODERAT_MEDIUM, totalFontSize, theme.text)
  totalLbl.x = paddingX
  totalLbl.y = curY
  frame.appendChild(totalLbl)
  const totalAmt = await createTextNode(formatCurrency(displayTotal), NOE_BOLD, totalFontSize, theme.text)
  totalAmt.x = Math.round(paddingX + contentW - (totalAmt.width || 0))
  totalAmt.y = curY
  totalAmt.name = 'cell-right'
  frame.appendChild(totalAmt)
  curY += TOTAL_ROW_H + FOOTNOTE_GAP

  // Footnote: when VAT is included, every price above already reflects it, so this is just
  // a short confirmation. When excluded (every price above is pre-VAT), the with-VAT
  // alternative is only shown if explicitly opted into via vatShowTotal — off by default,
  // so no extra figure appears unless asked for.
  const footnote = await createTextNode(
    vatIncluded
      ? '*IVA incluido'
      : (data.vatShowTotal
        ? '*IVA no incluido — Total con IVA: ' + formatCurrency(totalWithVat)
        : '*IVA no incluido'),
    MODERAT_REGULAR, FOOTNOTE_SIZE, theme.muted
  )
  footnote.x = paddingX
  footnote.y = curY
  frame.appendChild(footnote)

  makeBoxListAdaptive(frame, box)
  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify('Budget created')
  return frame
}

// Table: newline-separated rows of tab-separated cells. Free-text sentences routinely
// contain literal commas and periods (see the reference design), so — unlike every other
// chart type — this deliberately does NOT go through parseData's comma/colon/pipe format.
function parseTableRows(dataStr: string, columnsStr: string | undefined): { columns: string[]; rows: string[][] } {
  const columns = String(columnsStr || '').split('\t').map(c => c.trim()).filter(c => c.length > 0)
  const finalColumns = columns.length >= 2 ? columns : ['Column 1', 'Column 2']
  const rows: string[][] = []
  for (const line of String(dataStr || '').split('\n')) {
    if (!line.trim()) continue
    const cells = line.split('\t').map(c => c.trim())
    if (!cells.some(c => c.length > 0)) continue
    rows.push(cells)
  }
  return { columns: finalColumns, rows }
}

// A plain data table: bold header row, a divider beneath it, then plain text rows —
// matching the reference (header + one divider, no per-row dividers). Column widths are a
// fixed proportional split (first column wider, for the usual long free-text first column)
// rather than measured per-cell, so the layout doesn't jump around between edits. Each cell
// wraps within its column (textAutoResize 'HEIGHT' on a fixed width) since cell text can run
// to full sentences. No resize-adaptation, like budget — a static frame is the simplest,
// safest default for a first version.
// A data table with a full outer border and a thin divider between EVERY row (header
// included) — not just a divider under the header — matching the bordered-grid reference
// look, and reusing the same box convention as Budget (stroke, transparent fill) rather than
// a bespoke one. Row heights vary with wrapped text, so unlike Budget's fixed-height rows
// the box's final size isn't known until content is measured — built by laying everything
// out directly into `frame` first, then creating the box at its now-known size and
// reparenting that content into it (the same build-then-reparent technique already used for
// Timeline's plot area).
async function drawTableChart(data: ChartData): Promise<FrameNode | null> {
  const { columns, rows } = parseTableRows(data.data, data.tableColumns)
  if (!rows.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)

  const paddingX = 50, paddingTop = 40, paddingBottom = 40
  const boxPadX = 28
  // colX[i] is also exactly where the vertical divider between columns sits (see below) —
  // without a left inset, cell text would start flush against that line with zero gap.
  // CELL_PAD_LEFT/RIGHT together keep text clear of both the divider before it and the one
  // after it.
  const CELL_PAD_LEFT = 22
  const CELL_PAD_RIGHT = 24
  const HEADER_SIZE = TICK_LABEL_FONT_SIZE
  const CELL_SIZE = TICK_LABEL_FONT_SIZE - 4
  const ROW_V_PAD = 28

  const defaultWidth = 1100
  const { width: frameWidth } = resolveFrameSize(data, defaultWidth, 1)
  const contentW = frameWidth - paddingX * 2
  const boxInnerW = contentW - boxPadX * 2

  const n = columns.length
  const firstColShare = n > 1 ? 0.42 : 1
  const restShare = n > 1 ? (1 - firstColShare) / (n - 1) : 0
  const colWidths = columns.map((_, i) => Math.round(boxInnerW * (i === 0 ? firstColShare : restShare)))
  colWidths[n - 1] += boxInnerW - colWidths.reduce((a, b) => a + b, 0)
  // Row-local (0 = the row-wrapper's own left edge, which lines up with the box's left edge
  // — see wrapRowInAnchor calls below), NOT absolute frame coordinates — rows are built as
  // standalone wrapper frames rather than positioned directly against frame/box coordinates.
  const colX: number[] = []
  { let x = boxPadX; for (const w of colWidths) { colX.push(x); x += w } }

  const frame = figma.createFrame()
  frame.name = 'Chart'
  frame.fills = []
  frame.clipsContent = false
  frame.layoutMode = 'NONE'

  const makeCell = async (text: string, x: number, width: number, font: FontName, size: number, color: ToolColor): Promise<TextNode> => {
    const t = await createTextNode(text, font, size, color)
    t.x = x
    t.y = 0
    try {
      t.textAutoResize = 'HEIGHT'
      t.resize(Math.max(1, width - CELL_PAD_RIGHT), t.height || size)
    } catch { }
    return t
  }
  const addDivider = async (y: number) => {
    const d = await makeVectorPolyline([{ x: paddingX + boxPadX, y }, { x: paddingX + contentW - boxPadX, y }], theme.grid, 1)
    d.name = 'row-divider'
    frame.appendChild(d)
  }

  let curY = paddingTop + ROW_V_PAD
  let headerMaxH = 0
  const headerCells: TextNode[] = []
  for (let i = 0; i < columns.length; i++) {
    const cell = await makeCell(columns[i], colX[i] + CELL_PAD_LEFT, colWidths[i] - CELL_PAD_LEFT, MODERAT_MEDIUM, HEADER_SIZE, theme.text)
    headerCells.push(cell)
    headerMaxH = Math.max(headerMaxH, cell.height || HEADER_SIZE)
  }
  // Wrapped as a row-anchor (not appended directly) so live vertical resize can spread rows
  // out to fill a taller box (see makeBoxListAdaptive) without SCALE-distorting the text
  // nodes themselves.
  wrapRowInAnchor(frame, headerCells, headerCells.map(() => 'MIN' as const), paddingX, curY, contentW, headerMaxH)
  curY += headerMaxH + ROW_V_PAD
  await addDivider(curY)
  curY += ROW_V_PAD

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    let rowMaxH = 0
    const cells: TextNode[] = []
    for (let i = 0; i < columns.length; i++) {
      const cell = await makeCell(row[i] || '', colX[i] + CELL_PAD_LEFT, colWidths[i] - CELL_PAD_LEFT, MODERAT_REGULAR, CELL_SIZE, theme.text)
      cells.push(cell)
      rowMaxH = Math.max(rowMaxH, cell.height || CELL_SIZE)
    }
    wrapRowInAnchor(frame, cells, cells.map(() => 'MIN' as const), paddingX, curY, contentW, rowMaxH)
    curY += rowMaxH + ROW_V_PAD
    // Divider between rows, not after the last one (the box border already closes it off).
    if (r < rows.length - 1) {
      await addDivider(curY)
      curY += ROW_V_PAD
    }
  }

  // curY already includes the bottom inner padding (the unconditional +ROW_V_PAD after the
  // last row's text) — it IS the box's total content height, measured from paddingTop.
  const boxHeight = curY - paddingTop

  // Vertical column dividers — full box height (edge to edge, unlike the horizontal row
  // dividers which get a small inset), at each boundary between columns (not before the
  // first or after the last; the box border already closes those off). colX[i] for i>=1 is
  // already exactly that boundary (where column i's cells start, right after column i-1's
  // full allocated width) — offset by paddingX+boxPadX-boxPadX... i.e. paddingX, since colX
  // is row-local (0 = box's own left edge). Named 'col-divider' so makeBoxListAdaptive keeps
  // it pinned horizontally (column widths aren't reflowed on resize) while still SCALE-ing
  // vertically to keep spanning the box's full, growing height.
  for (let i = 1; i < columns.length; i++) {
    const vx = paddingX + colX[i]
    const vDivider = await makeVectorPolyline([{ x: vx, y: paddingTop }, { x: vx, y: paddingTop + boxHeight }], theme.grid, 1)
    vDivider.name = 'col-divider'
    frame.appendChild(vDivider)
  }

  const box = figma.createFrame()
  box.name = 'box'
  box.resize(Math.max(1, contentW), Math.max(1, boxHeight))
  box.x = paddingX
  box.y = paddingTop
  box.fills = []
  box.strokes = [solidPaint(theme.grid)]
  box.strokeWeight = 1
  try { box.cornerRadius = 4 } catch { }
  box.clipsContent = false

  const contentChildren = [...frame.children]
  contentChildren.forEach(child => {
    const c = child as SceneNode & { x: number; y: number }
    c.x -= box.x
    c.y -= box.y
    box.appendChild(c)
  })
  frame.appendChild(box)

  const frameHeight = Math.max(1, Math.round(paddingTop + boxHeight + paddingBottom))
  frame.resize(frameWidth, frameHeight)

  makeBoxListAdaptive(frame, box)
  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify('Table created')
  return frame
}

interface KpiStat { label: string; value: string; description: string }

// Tab-separated cells (Label / Value / Description) per newline-separated row — Description
// is free-text with commas/periods, same reasoning as Table and Index.
function parseKpiRows(str: string): KpiStat[] {
  const out: KpiStat[] = []
  for (const line of String(str || '').split('\n')) {
    if (!line.trim()) continue
    const cells = line.split('\t')
    const label = (cells[0] || '').trim()
    const value = (cells[1] || '').trim()
    const description = (cells[2] || '').trim()
    if (!label && !value && !description) continue
    out.push({ label, value, description })
  }
  return out
}

// "Main" sizing is for the 1- and 2-stat layouts (a single hero-style number, or two side by
// side). The 3+ layout's grid instead steps its value size down by position — 1st (hero,
// left) at the main 400pt scale, 2nd (top-right) at 300pt, 3rd/4th/5th… (the bottom row) at
// 200pt — label/description stay at one "secondary" size throughout; only the number itself
// is graduated.
const KPI_MAIN_VALUE_SIZE = 400
const KPI_MAIN_LABEL_SIZE = 42
const KPI_MAIN_DESC_SIZE = 22
const KPI_SECOND_VALUE_SIZE = 300
const KPI_SECONDARY_VALUE_SIZE = 200
const KPI_SECONDARY_LABEL_SIZE = 36
const KPI_SECONDARY_DESC_SIZE = 22
// Two distinct gaps within one stat's card, not a single uniform one: value→label is pulled
// in tight (negative — label sits up into the value's own line-height padding), while
// label→description gets real breathing room so the two tiers of text don't read as one
// run-on block.
const KPI_GAP_VALUE_LABEL = -24
const KPI_GAP_LABEL_DESC = 16
// The 2nd/top-right stat in the 3+ grid specifically wants its number pulled in closer to
// its label than every other stat.
const KPI_GAP_VALUE_LABEL_SECOND = -36
// Height is content-driven, like every other chart type's — NOT a fixed 850px: a fixed
// height either cramped/clipped real (long, wrapping) description text or left a lot of
// empty space for short content. A modest floor keeps a single short stat from collapsing
// into a tiny box. clipsContent stays on (unlike every other chart type) purely as a
// last-resort guard against edge cases in the sizing math above, not as the primary way
// content is kept within bounds.
const KPI_MIN_HEIGHT = 340
const KPI_MAX_WIDTH = 1780
// 1- and 2-stat layouts are a fixed width, not content-clamped like every other chart's
// frame — everything inside (the text column, the two columns' widths) adapts to fill it.
const KPI_ONE_TWO_WIDTH = 1753

interface KpiSizes { value: number; label: number; desc: number; gapValueLabel?: number; gapLabelDesc?: number }

// Draws one stat (value, then label, then muted description) as a real Figma auto-layout
// frame — not manually positioned/measured text nodes — so the card's own height is however
// tall its content naturally is, read directly via `.height` once appended — no manual
// "measure then compute a shift" dance needed for centering, unlike every earlier version of
// this function. Label and description are nested in their own inner auto-layout group so
// they can carry a DIFFERENT gap than the one between the value and that group — Figma auto
// layout only gives a frame one uniform itemSpacing, so two distinct gaps need two frames.
async function drawKpiStat(parent: FrameNode, stat: KpiStat, x: number, y: number, w: number, theme: Theme, sizes: KpiSizes): Promise<{ card: FrameNode; valueH: number }> {
  // resize() must run BEFORE the sizing-mode assignments below — calling it after silently
  // resets primaryAxisSizingMode back to 'FIXED' at whatever height was just passed in (a
  // real Figma auto-layout gotcha), which is exactly what was locking every card's height at
  // ~1px this whole time regardless of content: with clipsContent off that just let content
  // render past its own (never-actually-growing) box, which read as cutoff/overlap; with it
  // on, it hides everything. Sizing modes set AFTER resize() stick correctly.
  const makeAutoFrame = (name: string, gap: number) => {
    const f = figma.createFrame()
    f.name = name
    f.layoutMode = 'VERTICAL'
    f.resize(Math.max(1, w), 1)
    f.primaryAxisSizingMode = 'AUTO'
    f.counterAxisSizingMode = 'FIXED'
    f.primaryAxisAlignItems = 'MIN'
    f.counterAxisAlignItems = 'MIN'
    f.itemSpacing = gap
    f.fills = []
    return f
  }

  const card = makeAutoFrame('kpi-stat', sizes.gapValueLabel ?? KPI_GAP_VALUE_LABEL)
  // A hard backstop against any child (mainly the huge value digits) rendering wider than
  // its own column: width is locked explicitly below via resize() before each child is even
  // appended, so this should never actually trigger — but if it ever does, clipping within
  // the card keeps it from bleeding sideways into the next stat instead of overlapping it.
  card.clipsContent = true
  card.x = x
  card.y = y

  // Width is locked explicitly, BEFORE appendChild, the same way Table already wraps its
  // cells — not via layoutSizingHorizontal='FILL' after the fact, which is untested for text
  // children of an auto-layout frame in this codebase and, if it silently fails, leaves the
  // node at its own single-line width: undersized for wrapping (so height reads too short,
  // letting later blocks overlap it) and free to render past the column's edge sideways.
  const lockWidth = (t: TextNode) => { try { t.textAutoResize = 'HEIGHT'; t.resize(Math.max(1, w), t.height || 1) } catch { } }

  // The value itself is deliberately left at its natural single-line width — never wrapped,
  // since a number breaking across lines would look broken — card.clipsContent above is the
  // guard if a value is ever wider than its own column (crops rather than bleeding sideways
  // into the next stat).
  let valueH = 0
  if (stat.value) {
    const valueTxt = await createTextNode(stat.value, NOE_BOLD, sizes.value, theme.text)
    card.appendChild(valueTxt)
    valueH = valueTxt.height || sizes.value
  }
  if (stat.label || stat.description) {
    const textGroup = makeAutoFrame('kpi-stat-text', sizes.gapLabelDesc ?? KPI_GAP_LABEL_DESC)
    textGroup.clipsContent = false
    if (stat.label) {
      const labelTxt = await createTextNode(stat.label, MODERAT_REGULAR, sizes.label, theme.text)
      lockWidth(labelTxt)
      textGroup.appendChild(labelTxt)
    }
    if (stat.description) {
      const descTxt = await createTextNode(stat.description, MODERAT_REGULAR, sizes.desc, theme.muted)
      lockWidth(descTxt)
      textGroup.appendChild(descTxt)
    }
    card.appendChild(textGroup)
  }
  parent.appendChild(card)
  return { card, valueH }
}

// A stat block: unlike every other chart type this has no adaptive/live-resize behavior at
// all (nothing here stretches to fill extra frame space), so — same reasoning as height on
// every chart — its width is always recomputed fresh from content rather than preserving a
// prior manual resize; there'd be nothing for the extra width to do. Plain transparent
// frame like every other chart type (not a filled slide background) — dark/light theme only
// changes the text/dot colors, so a dark-themed KPI needs to be placed over dark artwork (or
// have a background added manually) to actually read as intended, the same tradeoff every
// other chart's dark theme already has. clipsContent is on, so content can never visually
// escape the frame regardless of length. Layout depends on how many stats there are: 1 stat
// reads left-to-right (value, a small accent dot, then its description); 2 stats sit side by
// side (value above description in each column), split by a centered accent dot; 3+ falls
// back to the hero+grid layout (first stat large on the left, the rest in a grid on the
// right — the first of those spans the top row, the rest split evenly below it). All three
// vertically center their content, measured from each stat's real auto-layout height.
async function drawKpiChart(data: ChartData): Promise<FrameNode | null> {
  const stats = parseKpiRows(data.data)
  if (!stats.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)
  const barColor = normalizeColor(data.barColor, RED_NORTH)

  const frame = figma.createFrame()
  frame.name = 'Chart'
  frame.fills = []
  frame.clipsContent = true
  frame.layoutMode = 'NONE'

  const paddingX = 70, paddingY = 70

  // Every stat, in every layout, uses the same two gaps (KPI_GAP_VALUE_LABEL/KPI_GAP_LABEL_DESC
  // defaults) — except the 2nd/top-right stat, which is pulled in even tighter between its
  // number and label.
  const mainSizes: KpiSizes = { value: KPI_MAIN_VALUE_SIZE, label: KPI_MAIN_LABEL_SIZE, desc: KPI_MAIN_DESC_SIZE }
  // 3+ layout: value size steps down by position (1st/hero → 2nd/top-right → 3rd+/bottom row).
  const heroSizes: KpiSizes = { value: KPI_MAIN_VALUE_SIZE, label: KPI_SECONDARY_LABEL_SIZE, desc: KPI_SECONDARY_DESC_SIZE }
  const secondSizes: KpiSizes = { value: KPI_SECOND_VALUE_SIZE, label: KPI_SECONDARY_LABEL_SIZE, desc: KPI_SECONDARY_DESC_SIZE, gapValueLabel: KPI_GAP_VALUE_LABEL_SECOND }
  const restSizes: KpiSizes = { value: KPI_SECONDARY_VALUE_SIZE, label: KPI_SECONDARY_LABEL_SIZE, desc: KPI_SECONDARY_DESC_SIZE }

  if (stats.length === 1) {
    const stat = stats[0]
    const gapAfterValue = 40, dotSize = 14, dotGap = 30
    // 1- and 2-stat frames are a fixed width — everything else adapts to fit inside it,
    // rather than the frame growing/shrinking to match a fixed text column.
    const frameWidth = KPI_ONE_TWO_WIDTH

    const valueTxt = await createTextNode(stat.value || '', NOE_BOLD, KPI_MAIN_VALUE_SIZE, theme.text)
    const valueW = valueTxt.width || KPI_MAIN_VALUE_SIZE
    const valueH = valueTxt.height || KPI_MAIN_VALUE_SIZE
    const textX = paddingX + valueW + gapAfterValue + dotSize + dotGap
    const textAvailW = Math.max(300, frameWidth - paddingX - textX)

    // Label + description stacked to the right of the dot.
    const textResult = await drawKpiStat(frame, { label: stat.label, value: '', description: stat.description }, textX, 0, textAvailW, theme, mainSizes)
    const textBlockH = textResult.card.height

    const blockH = Math.max(valueH, textBlockH)
    const frameHeight = Math.max(KPI_MIN_HEIGHT, blockH + paddingY * 2)
    const availH = frameHeight - paddingY * 2
    const blockY = paddingY + Math.round((availH - blockH) / 2)

    valueTxt.x = paddingX
    valueTxt.y = blockY + Math.round((blockH - valueH) / 2)
    frame.appendChild(valueTxt)

    const dot = figma.createEllipse()
    dot.resize(dotSize, dotSize)
    dot.x = paddingX + valueW + gapAfterValue
    dot.y = blockY + Math.round((blockH - valueH) / 2) + Math.round(valueH * 0.32)
    dot.fills = [solidPaint(barColor)]
    frame.appendChild(dot)

    textResult.card.y = blockY + Math.round((blockH - textBlockH) / 2)

    frame.resize(frameWidth, frameHeight)
  } else if (stats.length === 2) {
    const colGap = 90, dotSize = 14
    const frameWidth = KPI_ONE_TWO_WIDTH
    const colW = Math.floor((frameWidth - paddingX * 2 - colGap) / 2)

    const col1 = await drawKpiStat(frame, stats[0], paddingX, 0, colW, theme, mainSizes)
    const col2 = await drawKpiStat(frame, stats[1], paddingX + colW + colGap, 0, colW, theme, mainSizes)
    const blockH = Math.max(col1.card.height, col2.card.height)
    const frameHeight = Math.max(KPI_MIN_HEIGHT, blockH + paddingY * 2)
    const availH = frameHeight - paddingY * 2
    const blockY = paddingY + Math.round((availH - blockH) / 2)

    col1.card.y = blockY
    col2.card.y = blockY

    const dot = figma.createEllipse()
    dot.resize(dotSize, dotSize)
    dot.x = Math.round(paddingX + colW + colGap / 2 - dotSize / 2)
    dot.y = blockY + Math.round(col1.valueH * 0.32)
    dot.fills = [solidPaint(barColor)]
    frame.appendChild(dot)

    frame.resize(frameWidth, frameHeight)
  } else {
    // Only affects how far the hero sits from the divider/grid — dividerGridGap below stays
    // fixed, so widening this doesn't touch how close the vertical line sits to the grid.
    const colGap = 170
    const frameWidth = KPI_MAX_WIDTH
    const contentW = frameWidth - paddingX * 2

    const hero = stats[0]
    const secondary = stats.slice(1)
    const topStat = secondary[0]
    const bottomStats = secondary.slice(1)

    // Label and description both wrap once placed (lockWidth in drawKpiStat), so their raw
    // single-line width isn't what they actually "need" the way the value's is — a long
    // run-on sentence would otherwise force the hero (or a cramped grid cell) far wider than
    // it should be just because it happened to be typed without line breaks, starving every
    // other column of room. Capped at a sensible paragraph width; past that they just wrap
    // to more lines instead of dictating the column's width.
    const TEXT_WRAP_CAP = 420
    const measureStat = async (s: KpiStat, sizes: KpiSizes): Promise<number> => Math.max(
      await measureTextWidth(s.value, NOE_BOLD, sizes.value),
      Math.min(await measureTextWidth(s.label, MODERAT_REGULAR, sizes.label), TEXT_WRAP_CAP),
      Math.min(await measureTextWidth(s.description, MODERAT_REGULAR, sizes.desc), TEXT_WRAP_CAP),
    )

    const heroContentW = await measureStat(hero, heroSizes)
    const leftColW = clamp(Math.ceil(heroContentW), 240, Math.round(contentW * 0.42))
    // Whatever's left after the hero and the gap — the grid below fills this exactly.
    const rightMaxW = contentW - leftColW - colGap

    // The grid (values 2, 3, 4, 5…) fills whatever width the hero left behind, rather than
    // shrinking to each cell's own bare minimum — value 1 anchors the left side at its own
    // natural size, and everything else stretches to use the rest of the frame automatically,
    // same idea as a space-between layout that also fills its middle instead of leaving it
    // empty.
    const dividerGap = 40
    const cellGap = 56
    const n = Math.max(1, bottomStats.length)
    const equalShare = Math.max(140, Math.floor((rightMaxW - cellGap * (n - 1)) / n))
    const topW = rightMaxW
    const cellWidths: number[] = bottomStats.map(() => equalShare)
    const bottomRowW = cellWidths.reduce((a, b) => a + b, 0) + cellGap * Math.max(0, cellWidths.length - 1)
    const gridW = Math.max(topW, bottomRowW)
    const rightColX = Math.max(paddingX + leftColW + colGap, frameWidth - paddingX - gridW)

    const heroResult = await drawKpiStat(frame, hero, paddingX, 0, leftColW, theme, heroSizes)
    const leftH = heroResult.card.height

    const topResult = await drawKpiStat(frame, topStat, rightColX, 0, topW, theme, secondSizes)
    const bottomY0 = topResult.card.height + dividerGap

    // Packed left-to-right, each cell taking an equal share of the grid's width. Every
    // cell's own text/number stays left-aligned within its box — it's the box itself that
    // ends up on the right for the last cell (simply from being last in the packing order),
    // not the content shifting to hug that box's right edge.
    const cellXs: number[] = []
    const bottomResults: { card: FrameNode; valueH: number }[] = []
    let cx = rightColX
    for (let i = 0; i < bottomStats.length; i++) {
      cellXs.push(cx)
      bottomResults.push(await drawKpiStat(frame, bottomStats[i], cx, bottomY0, cellWidths[i], theme, restSizes))
      cx += cellWidths[i] + cellGap
    }
    const rightH = bottomY0 + Math.max(...bottomResults.map(r => r.card.height))

    // Height fits whichever column (hero or grid) is actually taller, not a fixed 850 —
    // real (long, wrapping) description text no longer fights a ceiling, and short content
    // still gets the same modest floor as the 1- and 2-stat layouts.
    const contentH = Math.max(leftH, rightH)
    const frameHeight = Math.max(KPI_MIN_HEIGHT, contentH + paddingY * 2)
    const availH = frameHeight - paddingY * 2
    frame.resize(frameWidth, frameHeight)

    // The hero sits bottom-left: all the vertical slack goes above it (bias 1, i.e. its
    // bottom edge lands exactly on the frame's bottom padding line), and counterAxisAlignItems
    // 'MIN' on its card already keeps it flush left. The right column stays vertically
    // centered. Since the frame's height is now sized to fit whichever column is tallest,
    // availH can never be less than either column's own height, so no overflow clamp is
    // needed here the way it was under the old fixed height.
    const shift = (h: number, bias: number) => paddingY + Math.round((availH - h) * bias)
    const leftShift = shift(leftH, 1)
    const rightShift = shift(rightH, 0.5)
    heroResult.card.y = leftShift
    topResult.card.y = rightShift
    for (const r of bottomResults) r.card.y = (r.card.y as number) + rightShift

    // Biased toward the grid, not centered in the hero↔grid gap — numbers 2, 3, 4, 5… sit
    // close against this line, while the hero side absorbs whatever's left of that gap.
    // Floored a bit past the hero's own right edge so it can't collide with it when the
    // overall gap is small.
    const dividerGridGap = 50
    const colDividerX = Math.max(paddingX + leftColW + 30, rightColX - dividerGridGap)

    // A real gap between the 2nd stat's own text and the line below it — sitting flush at
    // its card's exact bottom edge read as the line overlapping the description text.
    const dividerTextGap = 20
    const hDividerY = topResult.card.height + rightShift + dividerTextGap
    // Starts at the vertical divider, not at rightColX — the grid can now sit well to the
    // right of that line (it's biased toward the grid, not centered in the gap), so the
    // horizontal line has to reach left to actually touch it.
    const hDivider = await makeVectorPolyline([{ x: colDividerX, y: hDividerY }, { x: rightColX + gridW, y: hDividerY }], theme.grid, 1)
    frame.appendChild(hDivider)

    // Vertical dividers between bottom cells reach all the way up to meet the horizontal
    // line above (not just up to where the bottom row itself starts), so the grid reads as
    // one connected set of borders instead of floating lines with a gap between them.
    const bottomBottomY = rightH + rightShift
    for (let i = 0; i < bottomStats.length - 1; i++) {
      const vx = cellXs[i + 1] - cellGap / 2
      const vDivider = await makeVectorPolyline([{ x: vx, y: hDividerY }, { x: vx, y: bottomBottomY }], theme.grid, 1)
      frame.appendChild(vDivider)
    }

    const colDivider = await makeVectorPolyline([{ x: colDividerX, y: paddingY }, { x: colDividerX, y: frameHeight - paddingY }], theme.grid, 1)
    frame.appendChild(colDivider)
  }

  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify('KPI created')
  return frame
}

// Gantt-style timeline: rows are either a "phase" (a big red bar + bold label, spanning a
// date range) or a "task" (a thinner black bar + label, the breakdown under a phase). The
// grid's start is derived automatically from the earliest task's date (normalized to the
// 1st of its month, so the grid always begins on a clean month boundary) — there's no
// separate manual "start date" setting to keep in sync with the actual data. Every month
// gets equal on-screen width regardless of its real day count (28-31) — that keeps the
// header grid visually uniform — but a task's exact day still maps proportionally *within*
// its own month's column, so day-level positioning is preserved.
async function drawTimelineChart(data: ChartData): Promise<FrameNode | null> {
  const valid = parseTimelineRows(data.data)
  if (!valid.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)

  const minStart = new Date(Math.min(...valid.map(r => r.start.getTime())))
  const gridYear = minStart.getFullYear()
  const gridMonth0 = minStart.getMonth()
  const gridStart = new Date(gridYear, gridMonth0, 1)
  const dayOf = (d: Date): number => Math.round((d.getTime() - gridStart.getTime()) / 86400000)

  // Biweekly/monthly split each month into N *equal* pieces (2 or 1) — that's a sensible,
  // intentional convention (a "quincena" genuinely is half a month, day~15 in / day~15 out).
  // Weekly is different: a real week is a fixed 7-day span, not "month ÷ 4" — dividing every
  // month into exactly 4 equal pieces regularly produces ~7.5-7.75-day blocks instead of
  // real weeks, so a date the user picked from an actual calendar week almost never landed
  // on one of those artificial quarter-boundaries (the bar would stop short of, or start
  // past, the block edge). Weekly therefore builds real 7-day-aligned blocks per month
  // instead (see blockDayCounts below), with a short trailing block absorbing whatever days
  // are left over (1-7) rather than forcing an even split.
  const isRealWeeks = data.granularity === 'week'
  const granularity = isRealWeeks ? 4 : data.granularity === 'monthly' ? 1 : 2
  const subLabel = (sub: number): string => granularity === 1 ? '' : granularity === 2 ? 'Q' + (sub + 1) : 'S' + (sub + 1)

  // A task's day-index is inclusive (dayOf(end) is the last day it's still running), but
  // for laying out the grid/rendering a bar we need the *exclusive* end — one day past
  // that — otherwise a task ending on the very last day of a block (e.g. a Sunday closing
  // out a week) computes to a fraction just short of 1.0 and its bar visibly stops short of
  // the block's right edge instead of reaching it.
  const spanEnd = Math.max(...valid.map(r => dayOf(r.end))) + 1

  // blockDayCounts holds each sub-block's real day span within the month — uniform
  // (dayCount/granularity) for biweekly/monthly, but variable for weekly (a run of 7s, plus
  // a short remainder). dayToX below walks this list rather than assuming every block is the
  // same width, which is what actually lets weekly's trailing short block exist at all.
  type MonthBucket = { label: string; dayStart: number; dayCount: number; blockDayCounts: number[]; colStart: number }
  const months: MonthBucket[] = []
  let cursorDay = 0, y = gridYear, m = gridMonth0
  while (cursorDay < spanEnd) {
    const count = daysInMonth(y, m)
    let blockDayCounts: number[]
    if (isRealWeeks) {
      blockDayCounts = []
      let remaining = count
      while (remaining > 0) { const chunk = Math.min(7, remaining); blockDayCounts.push(chunk); remaining -= chunk }
    } else {
      blockDayCounts = new Array(granularity).fill(count / granularity)
    }
    months.push({ label: MONTH_NAMES_ES[m], dayStart: cursorDay, dayCount: count, blockDayCounts, colStart: 0 })
    cursorDay += count
    m++
    if (m > 11) { m = 0; y++ }
  }
  // Trim the last month to only the sub-period blocks actually needed to reach spanEnd —
  // showing a full month when the data only covers a week or two would waste most of the
  // chart's width. A block the data only partially reaches still counts as needed (rounds
  // up), so a task landing mid-block isn't cut off — this only drops fully-unused blocks.
  {
    const last = months[months.length - 1]
    let acc = last.dayStart
    const kept: number[] = []
    for (const d of last.blockDayCounts) {
      if (acc >= spanEnd) break
      kept.push(d)
      acc += d
    }
    last.blockDayCounts = kept.length ? kept : [last.blockDayCounts[0]]
  }
  let colCursor = 0
  for (const mo of months) { mo.colStart = colCursor; colCursor += mo.blockDayCounts.length }

  const paddingLeft = 60, paddingRight = 60
  const monthHeaderH = 60
  // The rule sits between the month-name row and the sub-period block row (not below both),
  // and the vertical gridlines start from that same line — so they visually divide the
  // sub-period blocks and the bars below, without cutting through the month names above.
  const headerRuleY = monthHeaderH
  const subHeaderH = granularity > 1 ? 60 : 0
  const paddingTop = headerRuleY + subHeaderH + 40
  const paddingBottom = 40
  const totalCols = colCursor

  // Phase (red, bold) and task (black) rows, stacked top-to-bottom in data-entry order —
  // a phase row acts as a section header for the task rows that follow it. Each row is a
  // real Figma auto-layout frame (label stacked above bar, centered, fixed gap) rather than
  // two independently-positioned nodes — auto-layout children physically cannot overlap
  // each other, so this is a structural guarantee rather than an offset calculated to
  // "probably" be big enough. The same gap value is used for both phase and task rows, so
  // the label-to-bar padding reads as consistent across the whole chart. Declared up here
  // (not just before the row loop) so the height *estimate* below can share the exact same
  // gap constants as the real per-row formula in the loop, instead of an independently
  // hand-tuned number that silently drifts out of sync with it (which is exactly what left
  // a large empty gap under the last row before this fix — the estimate assumed rows nearly
  // 50% taller than what the loop actually draws).
  const ROW_LABEL_BAR_GAP = 10
  const ROW_GAP = 24
  // Real per-row height also depends on the label's actual rendered height, which isn't
  // known until it's measured in the loop below — this mirrors that same formula with an
  // estimated line height (measured text is normally close to fontSize * ~1.25) purely to
  // size the frame's *default* height reasonably tightly around its content.
  const LABEL_LINE_HEIGHT_ESTIMATE = 1.25
  const estimateRowHeight = (isPhase: boolean): number => {
    const labelSize = isPhase ? TICK_LABEL_FONT_SIZE : TICK_LABEL_FONT_SIZE - 8
    const barThickness = isPhase ? 5 : 4
    return Math.round(labelSize * LABEL_LINE_HEIGHT_ESTIMATE) + ROW_LABEL_BAR_GAP + barThickness + ROW_GAP
  }
  const rowsHeight = valid.reduce((sum, r) => sum + estimateRowHeight(r.isPhase), 0)

  const defaultWidth = paddingLeft + paddingRight + totalCols * 110
  const defaultHeight = paddingTop + rowsHeight + paddingBottom
  // defaultWidth doubles as the floor — see drawVerticalChart's identical fix for why: the
  // shared MIN_CHART_WIDTH is unrelated to how many date columns this timeline spans, and
  // would force a short date range wider than its own per-column math asks for.
  const { width: frameWidth, height: frameHeight } = resolveFrameSize(data, defaultWidth, defaultHeight, defaultWidth)

  const frame = figma.createFrame()
  frame.resize(frameWidth, frameHeight)
  frame.name = 'Chart'
  frame.fills = []
  frame.clipsContent = false
  frame.layoutMode = 'NONE'

  const plotX0 = paddingLeft
  const plotW = frameWidth - paddingLeft - paddingRight
  const colW = plotW / totalCols

  const dayToX = (day: number): number => {
    let mi = months.length - 1
    for (let i = 0; i < months.length; i++) {
      if (day < months[i].dayStart + months[i].dayCount) { mi = i; break }
    }
    const month = months[mi]
    // Walk the month's own blocks (which may be different real day-spans — weekly's
    // trailing block is often shorter than 7) to find which one `day` actually falls in,
    // rather than assuming every block within the month is the same width.
    let blockStart = month.dayStart
    for (let bi = 0; bi < month.blockDayCounts.length; bi++) {
      const bd = month.blockDayCounts[bi]
      const blockEnd = blockStart + bd
      if (day < blockEnd || bi === month.blockDayCounts.length - 1) {
        const frac = clamp((day - blockStart) / bd, 0, 1)
        return plotX0 + (month.colStart + bi) * colW + frac * colW
      }
      blockStart = blockEnd
    }
    return plotX0 + (month.colStart + month.blockDayCounts.length) * colW
  }
  // Snaps a bar edge to the side (or middle) of a sub-period block, but only when it's
  // already close to one — not as a blanket rule. Unconditionally rounding every edge to
  // the nearest of just 3 points per column is fine when there are many columns, but with
  // few (which happens often, since the grid only ever renders as many columns as the data
  // needs) it can round two genuinely different dates weeks apart to the exact same pixel,
  // making their bars indistinguishable regardless of how different their real durations
  // are. Snapping only within a small tolerance keeps the "lines up cleanly with the grid"
  // benefit for dates that land right on a boundary, without destroying precision elsewhere.
  const SNAP_TOLERANCE_PX = 6
  const snapToHalfColumn = (x: number): number => {
    const half = colW / 2
    const nearest = plotX0 + clamp(Math.round((x - plotX0) / half) * half, 0, plotW)
    return Math.abs(nearest - x) <= SNAP_TOLERANCE_PX ? nearest : x
  }

  const barColor = normalizeColor(data.barColor, RED_NORTH)

  // Month + sub-period headers, and the vertical gridlines marking each column boundary.
  // Each month only renders as many sub-period blocks as it actually has (months[i]
  // .blockDayCounts, trimmed above) — usually the full granularity, except possibly the
  // last month. Weekly's sub-labels ("S1", "S2"…) count continuously across the whole grid
  // instead of resetting at each month boundary, since they represent real, ongoing weeks —
  // "S5" in month 2 is a different week from "S1" in month 1, not a repeat of it. Biweekly's
  // "Q1"/"Q2" stay per-month (first/second half of *this* month), which is what that
  // convention actually means.
  let globalWeekIdx = 0
  for (let i = 0; i < months.length; i++) {
    const month = months[i]
    const mx0 = plotX0 + month.colStart * colW
    const mw = month.blockDayCounts.length * colW
    const mlbl = await createTextNode(month.label, MODERAT_REGULAR, VALUE_FONT_SIZE, theme.text)
    mlbl.x = Math.round(mx0 + mw / 2 - (mlbl.width || 0) / 2)
    mlbl.y = 0
    frame.appendChild(mlbl)

    for (let s = 0; s < month.blockDayCounts.length; s++) {
      const sx0 = mx0 + s * colW
      if (granularity > 1) {
        const slbl = await createTextNode(isRealWeeks ? subLabel(globalWeekIdx++) : subLabel(s), MODERAT_REGULAR, TICK_LABEL_FONT_SIZE, theme.text)
        slbl.x = Math.round(sx0 + colW / 2 - (slbl.width || 0) / 2)
        slbl.y = headerRuleY + 16
        frame.appendChild(slbl)
      }
      const gl = await makeVectorPolyline([{ x: Math.round(sx0), y: headerRuleY }, { x: Math.round(sx0), y: frameHeight - paddingBottom }], theme.grid, 1)
      // Named so makeTimelineAdaptive can give it a fixed-top/fixed-bottom STRETCH instead
      // of the default MIN pin — a plain pin would leave its length fixed at creation time,
      // so it'd visibly stop short of the bottom once rows grow the frame taller.
      gl.name = 'grid-line'
      frame.appendChild(gl)
    }
  }
  const lastGl = await makeVectorPolyline([{ x: Math.round(plotX0 + plotW), y: headerRuleY }, { x: Math.round(plotX0 + plotW), y: frameHeight - paddingBottom }], theme.grid, 1)
  lastGl.name = 'grid-line'
  frame.appendChild(lastGl)
  const headerRule = await makeVectorPolyline([{ x: plotX0, y: headerRuleY }, { x: plotX0 + plotW, y: headerRuleY }], theme.text, 1.5)
  frame.appendChild(headerRule)

  let curY = paddingTop
  for (const r of valid) {
    const x0 = snapToHalfColumn(dayToX(dayOf(r.start)))
    const x1 = snapToHalfColumn(dayToX(dayOf(r.end) + 1))
    const barW = Math.max(2, x1 - x0)

    const isPhase = r.isPhase
    const barThickness = isPhase ? 5 : 4
    // Smaller than a phase label — reinforces that this is a sub-category/breakdown item,
    // not a top-level phase, purely through scale (in addition to weight/color).
    const labelSize = isPhase ? TICK_LABEL_FONT_SIZE : TICK_LABEL_FONT_SIZE - 8
    const lbl = await createTextNode(r.label, isPhase ? MODERAT_MEDIUM : MODERAT_REGULAR, labelSize, isPhase ? barColor : theme.text)
    // Measured before the row-entry frame exists, so its natural (unstretched) height can
    // be set explicitly up front — needed because primaryAxisSizingMode is FIXED, not AUTO,
    // so it can later be resized live by makeTimelineAdaptive's vertical SCALE constraint.
    const naturalHeight = (lbl.height || labelSize) + ROW_LABEL_BAR_GAP + barThickness

    const rowEntry = figma.createFrame()
    rowEntry.name = 'row-entry'
    rowEntry.layoutMode = 'VERTICAL'
    rowEntry.counterAxisSizingMode = 'FIXED'
    rowEntry.primaryAxisSizingMode = 'FIXED'
    rowEntry.primaryAxisAlignItems = 'MIN'
    rowEntry.counterAxisAlignItems = 'CENTER'
    // A fixed, guaranteed minimum gap: MIN/CENTER/MAX alignment (unlike SPACE_BETWEEN)
    // never compresses itemSpacing below this value, even if the row-entry later ends up
    // smaller than its natural height — content overflows the frame's edge in that case
    // instead of the gap shrinking, so the label can never end up touching its own bar.
    rowEntry.itemSpacing = ROW_LABEL_BAR_GAP
    rowEntry.fills = []
    // Never clip: a label wider than its (date-span-based) bar is expected and should
    // overflow visibly on both sides, centered, rather than being cropped to the bar width.
    rowEntry.clipsContent = false
    rowEntry.resize(Math.max(1, barW), naturalHeight)
    rowEntry.x = x0
    rowEntry.y = curY

    rowEntry.appendChild(lbl)
    const bar = createRect(barW, barThickness, solidPaint(isPhase ? barColor : theme.text))
    // layoutSizingHorizontal is only meaningful once the node is actually a child of an
    // auto-layout frame — set after appendChild, not before, so it reliably takes effect
    // and the bar keeps tracking the row-entry's width through a later live resize.
    rowEntry.appendChild(bar)
    try { (bar as any).layoutSizingHorizontal = 'FILL' } catch { }

    frame.appendChild(rowEntry)
    curY += naturalHeight + ROW_GAP
  }

  makeTimelineAdaptive(frame, paddingLeft, paddingRight, frameWidth, frameHeight)
  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify('Timeline created')
  return frame
}

async function drawHorizontalChart(data: ChartData): Promise<FrameNode | null> {
  const entries = parseData(data.data)
  if (!entries.length) {
    figma.notify('No data entries to draw')
    return null
  }
  await loadFonts()
  const theme = getTheme(data.theme)

  const paddingLeft = 150
  const paddingRight = 90
  const paddingTop = 220
  const paddingBottom = 140
  const rowGap = 40
  const rowHeight = 90
  const colCount = entries.length
  const defaultHeight = paddingTop + paddingBottom + colCount * rowHeight + (colCount - 1) * rowGap
  const { width: frameWidth, height: frameHeight } = resolveFrameSize(data, 1200, defaultHeight)

  const frame = figma.createFrame()
  frame.resize(frameWidth, frameHeight)
  frame.name = 'Chart'
  frame.fills = [] // Transparent by default so the chart drops onto any background.
  // Never clip: even though height always comes from content now, this stays as a safety
  // net so nothing is ever silently cropped — better to overflow visibly than to lose a
  // bar, axis, or half a circle.
  frame.clipsContent = false
  frame.layoutMode = 'NONE'

  const maxVal = Math.max(...entries.map(e => e.value))
  const barAreaWidth = frameWidth - paddingLeft - paddingRight
  const nice = niceScale(maxVal, 8)
  const scale = nice.max > 0 ? barAreaWidth / nice.max : 1
  const chartBottom = paddingTop + colCount * rowHeight + (colCount - 1) * rowGap

  for (let i = 0; i < nice.ticks.length; i++) {
    const v = nice.ticks[i]
    const x = Math.round(paddingLeft + v * scale)
    const tick = await makeVectorPolyline([{ x, y: paddingTop }, { x, y: chartBottom }], theme.grid, 1)
    try { (tick as any).dashPattern = GRID_DASH } catch { }
    frame.appendChild(tick)

    const lbl = await createTextNode(formatAxisValue(v), MODERAT_REGULAR, TICK_FONT_SIZE, theme.text)
    lbl.x = Math.round(x - (lbl.width || 0) / 2)
    lbl.y = chartBottom + 24
    frame.appendChild(lbl)
  }
  await addCartesianAxes(frame, theme, paddingLeft, paddingTop, frameWidth - paddingLeft - paddingRight, chartBottom - paddingTop)

  const barColor = normalizeColor(data.barColor, RED_NORTH)
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const y = paddingTop + i * (rowHeight + rowGap)

    const lbl = await createTextNode(e.label, MODERAT_REGULAR, TICK_LABEL_FONT_SIZE, theme.text)
    lbl.name = 'y-axis-label'
    // Always right-aligned against the same edge (frame isn't clipped, so a long label is
    // free to run past the left edge rather than break alignment with the rest of the axis).
    lbl.textAlignHorizontal = 'RIGHT'
    lbl.x = paddingLeft - 24 - (lbl.width || 0)
    lbl.y = Math.round(y + rowHeight / 2 - TICK_LABEL_FONT_SIZE / 2)
    frame.appendChild(lbl)

    const w = Math.max(2, Math.round(e.value * scale))

    const bar = createRect(w, rowHeight, solidPaint(barColor))
    bar.x = paddingLeft
    bar.y = y
    frame.appendChild(bar)

    const valTxt = await createValueLabel(e.value, VALUE_FONT_SIZE, theme.text)
    valTxt.x = paddingLeft + w + 28
    valTxt.y = Math.round(y + rowHeight / 2 - VALUE_FONT_SIZE / 2)
    frame.appendChild(valTxt)
  }

  makeChartAdaptive(frame, paddingLeft, paddingRight, paddingTop, paddingBottom, frameWidth, frameHeight)
  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  await figma.clientStorage.setAsync(CHART_DATA_KEY, data)
  placeNewChartFrame(frame)
  figma.notify('Horizontal chart created')
  return frame
}

// Funnel: one column of centered, tapering bars (each row's width proportional to its
// value vs. the funnel's largest value, progressively lighter per row via
// seriesColorsLight, the same way Progress/Timeline do for their multi-series palettes),
// flanked by a label column on the left and a "Conv. Rate" column on the right (each row's
// conversion from the row directly above it, blank on the first row). Built as four sibling
// Figma auto-layout columns (label / bars / divider / conv-rate) inside one HORIZONTAL
// frame, rather than four cells per horizontal row — every column uses the identical
// itemSpacing/row-height rhythm (a blank header-height spacer, then one rowHeight-tall slot
// per entry), which is what keeps row i's label, bar and percentage pinned level with each
// other across columns. The divider column holds exactly one rect spanning every row's
// combined height in one piece (not a per-row segment), so it reads as a single unbroken
// line rather than a dashed-looking stack of fragments — its height is deliberately derived
// from the exact same rowHeight/rowGap math as the other columns' total content height, so
// it lines up with the first row's top edge and the last row's bottom edge exactly. Reuses
// the shared comma-based parseData — funnel values are always simple positive counts, so no
// custom tab-separated parser is needed the way Index/KPI required for their extra per-row
// fields.
async function drawFunnelChart(data: ChartData): Promise<FrameNode | null> {
  const entries = parseData(data.data)
  if (!entries.length) {
    figma.notify('No data entries to draw')
    return null
  }
  await loadFonts()
  const theme = getTheme(data.theme)

  const rowHeight = 90
  const headerHeight = 44
  const rowGap = 24
  const cellGap = 32
  // Extra breathing room specifically between the bar column and the divider/Conv. Rate
  // block on its right — on top of the normal cellGap on either side of it, not instead of.
  const barToConvGap = 40
  const dividerWidth = 2
  const convColWidth = 200
  const barColor = normalizeColor(data.barColor, RED_NORTH)
  const colors = seriesColorsLight(barColor, entries.length, theme.bg)
  const maxVal = Math.max(...entries.map(e => e.value), 1)
  const rowCount = entries.length

  // Column widths are measured from real content rather than guessed, so nothing the
  // auto-layout builds below is ever undersized.
  let maxLabelW = 0
  for (const e of entries) {
    const w = await measureTextWidth(e.label, MODERAT_REGULAR, TICK_LABEL_FONT_SIZE)
    if (w > maxLabelW) maxLabelW = w
  }
  const labelColWidth = clamp(Math.ceil(maxLabelW) + 8, 140, 420)

  let maxValueW = 0
  for (const e of entries) {
    const { numPart, suffix } = formatValue(e.value)
    const w = await measureTextWidth(numPart + suffix, NOE_REGULAR, VALUE_FONT_SIZE)
    if (w > maxValueW) maxValueW = w
  }

  const { width: frameWidth } = resolveFrameSize(data, 1300, 1)
  const barZoneWidth = Math.max(160, frameWidth - labelColWidth - barToConvGap - dividerWidth - convColWidth - cellGap * 3)
  // The bar's own max width leaves room, inside the same zone, for its value label plus a
  // safety margin — so the widest bar (the max-value row) and its label never run past the
  // zone's own right edge into the divider that follows it.
  const barMaxWidth = Math.max(24, barZoneWidth - maxValueW - 28 - 8)
  // Exactly matches every other column's total content height (header + N row slots + the N
  // gaps between them) minus the header's own slot and its one gap to row 1 — see the
  // divider column below for how this keeps the line's ends level with row 1's top and the
  // last row's bottom.
  const rowsSpanHeight = rowCount * rowHeight + (rowCount - 1) * rowGap
  const frameHeight = headerHeight + rowGap + rowsSpanHeight

  const frame = figma.createFrame()
  frame.name = 'Chart'
  frame.layoutMode = 'HORIZONTAL'
  frame.resize(Math.max(1, frameWidth), Math.max(1, frameHeight))
  // FIXED on both axes (not the usual AUTO-hug for an auto-layout frame) so the frame stays
  // freely draggable-resizable on the canvas in both directions — see the FILL wiring below
  // for how that extra width/height actually reaches the columns and rows inside it.
  frame.primaryAxisSizingMode = 'FIXED'
  frame.counterAxisSizingMode = 'FIXED'
  frame.primaryAxisAlignItems = 'MIN'
  frame.counterAxisAlignItems = 'MIN'
  frame.itemSpacing = cellGap
  frame.fills = []
  frame.clipsContent = false

  const makeColumn = (name: string, width: number, height: number): FrameNode => {
    const col = figma.createFrame()
    col.name = name
    col.layoutMode = 'VERTICAL'
    col.resize(Math.max(1, width), Math.max(1, height))
    // FIXED (not AUTO-hug) so the column accepts the 'FILL' applied to it below once it's a
    // child of the frame — a hug-sized node can't also be told to fill its parent.
    col.primaryAxisSizingMode = 'FIXED'
    col.counterAxisSizingMode = 'FIXED'
    col.primaryAxisAlignItems = 'MIN'
    col.counterAxisAlignItems = 'MIN'
    col.itemSpacing = rowGap
    col.fills = []
    col.clipsContent = false
    return col
  }
  // A fixed-size, non-auto-layout slot for one row's worth of content in a column — content
  // is centered inside it manually (via x/y + constraints), the same "row height" every
  // column shares so row i lines up across all four columns.
  const makeSlot = (width: number, height: number): FrameNode => {
    const slot = figma.createFrame()
    slot.name = 'slot'
    slot.layoutMode = 'NONE'
    slot.resize(Math.max(1, width), height)
    slot.fills = []
    slot.clipsContent = false
    return slot
  }
  const lockWidth = (t: TextNode, w: number) => { try { t.textAutoResize = 'HEIGHT'; t.resize(Math.max(1, w), t.height || 1) } catch { } }
  // Every row slot (as opposed to the header spacer above it) grows to absorb its share of
  // any extra height the frame is dragged to on canvas — identically in every column, so
  // row i still lines up across all four columns after a resize. Text inside a slot only
  // re-centers (CENTER, no distortion); slot itself just needs to actually grow (FILL).
  const growVertically = (node: SceneNode) => { try { (node as any).layoutSizingVertical = 'FILL' } catch { } }

  // Label column: blank header spacer, then one right-aligned label per row.
  const labelCol = makeColumn('funnel-labels', labelColWidth, frameHeight)
  labelCol.appendChild(makeSlot(labelColWidth, headerHeight))
  for (const e of entries) {
    const slot = makeSlot(labelColWidth, rowHeight)
    const lbl = await createTextNode(e.label, MODERAT_REGULAR, TICK_LABEL_FONT_SIZE, theme.text)
    lbl.textAlignHorizontal = 'RIGHT'
    lockWidth(lbl, labelColWidth)
    lbl.x = 0
    lbl.y = Math.round(rowHeight / 2 - TICK_LABEL_FONT_SIZE / 2)
    try { (lbl as any).constraints = { horizontal: 'MIN', vertical: 'CENTER' } } catch { }
    slot.appendChild(lbl)
    labelCol.appendChild(slot)
    growVertically(slot)
  }
  frame.appendChild(labelCol)
  try { (labelCol as any).layoutSizingVertical = 'FILL' } catch { }

  // Bar column: blank header spacer, then one centered, value-proportional bar per row.
  const barCol = makeColumn('funnel-bars', barZoneWidth, frameHeight)
  const barHeaderSpacer = makeSlot(barZoneWidth, headerHeight)
  barCol.appendChild(barHeaderSpacer)
  try { (barHeaderSpacer as any).layoutSizingHorizontal = 'FILL' } catch { }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const slot = makeSlot(barZoneWidth, rowHeight)
    const w = Math.max(2, Math.round((e.value / maxVal) * barMaxWidth))
    const barX = Math.round((barZoneWidth - w) / 2)
    const bar = createRect(w, rowHeight, solidPaint(colors[i]), 8)
    bar.x = barX
    bar.y = 0
    // SCALE keeps the bar's width AND position proportional to the slot's own width as it
    // widens (the same trick the rest of this plugin's charts use for value-proportional
    // bars) — STRETCH so its thickness always exactly matches the slot's (possibly grown)
    // row height instead of leaving a gap above/below it.
    try { (bar as any).constraints = { horizontal: 'SCALE', vertical: 'STRETCH' } } catch { }
    slot.appendChild(bar)

    const valTxt = await createValueLabel(e.value, VALUE_FONT_SIZE, theme.text)
    valTxt.x = barX + w + 28
    valTxt.y = Math.round(rowHeight / 2 - VALUE_FONT_SIZE / 2)
    // Wrapped in an anchor (rather than a plain SCALE constraint on the text itself, which
    // would stretch/distort the glyphs) — the anchor scales as the bar next to it does, and
    // because both started at the same fixed gap and scale by the same ratio, the value
    // label lands exactly at the bar's new end position after any width resize.
    const valAnchor = wrapInAnchor(slot, valTxt, slot.children.length)
    try { (valAnchor as any).constraints = { horizontal: 'SCALE', vertical: 'CENTER' } } catch { }
    barCol.appendChild(slot)
    growVertically(slot)
    // Also grow horizontally, tracking barCol's own FILL-driven width — without this the
    // slot would stay pinned at its original width even as the column around it widens,
    // leaving the bar's SCALE constraint with nothing to actually react to.
    try { (slot as any).layoutSizingHorizontal = 'FILL' } catch { }
  }
  frame.appendChild(barCol)
  try { (barCol as any).layoutSizingHorizontal = 'FILL'; (barCol as any).layoutSizingVertical = 'FILL' } catch { }

  // Extra gap column: on top of the normal cellGap already on both its sides, this pushes
  // the divider/Conv. Rate block further away from the bars specifically.
  const convGapSpacer = figma.createFrame()
  convGapSpacer.name = 'spacer'
  convGapSpacer.resize(barToConvGap, 1)
  convGapSpacer.fills = []
  frame.appendChild(convGapSpacer)

  // Divider column: blank header spacer, then a single rect spanning every row in one piece
  // — it grows by the same total amount as the combined growth of every other column's row
  // slots (see rowsSpanHeight above for why that math lines up), so its ends stay level with
  // the first row's top and the last row's bottom no matter how tall the frame is dragged.
  const dividerCol = makeColumn('funnel-divider', dividerWidth, frameHeight)
  dividerCol.appendChild(makeSlot(dividerWidth, headerHeight))
  const dividerLine = createRect(dividerWidth, rowsSpanHeight, solidPaint(theme.grid))
  dividerCol.appendChild(dividerLine)
  growVertically(dividerLine)
  frame.appendChild(dividerCol)
  try { (dividerCol as any).layoutSizingVertical = 'FILL' } catch { }

  // Conv. Rate column: header label, then one centered percentage per row (blank on row 1).
  const convCol = makeColumn('funnel-conv-rate', convColWidth, frameHeight)
  const headerSlot = makeSlot(convColWidth, headerHeight)
  const headerTxt = await createTextNode('Conv. Rate', MODERAT_REGULAR, TICK_LABEL_FONT_SIZE, theme.muted)
  headerTxt.textAlignHorizontal = 'CENTER'
  lockWidth(headerTxt, convColWidth)
  headerTxt.x = 0
  headerTxt.y = Math.round(headerHeight / 2 - TICK_LABEL_FONT_SIZE / 2)
  headerSlot.appendChild(headerTxt)
  convCol.appendChild(headerSlot)
  for (let i = 0; i < entries.length; i++) {
    const slot = makeSlot(convColWidth, rowHeight)
    if (i > 0 && entries[i - 1].value > 0) {
      const pct = (entries[i].value / entries[i - 1].value) * 100
      const pctTxt = await createTextNode(pct.toFixed(1) + '%', MODERAT_MEDIUM, VALUE_FONT_SIZE, theme.text)
      pctTxt.textAlignHorizontal = 'CENTER'
      lockWidth(pctTxt, convColWidth)
      pctTxt.x = 0
      pctTxt.y = Math.round(rowHeight / 2 - VALUE_FONT_SIZE / 2)
      try { (pctTxt as any).constraints = { horizontal: 'MIN', vertical: 'CENTER' } } catch { }
      slot.appendChild(pctTxt)
    }
    convCol.appendChild(slot)
    growVertically(slot)
  }
  frame.appendChild(convCol)
  try { (convCol as any).layoutSizingVertical = 'FILL' } catch { }

  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  await figma.clientStorage.setAsync(CHART_DATA_KEY, data)
  placeNewChartFrame(frame)
  figma.notify('Funnel chart created')
  return frame
}

// Force graph / network: one center node radiating straight lines to every other node,
// arranged evenly around it — a static stand-in for a physics-based force layout (this
// plugin has no runtime simulation loop to relax node positions against), but reads the
// same way: one hub, everything else orbiting it, sized by its own value. Reuses the plain
// label:value comma format (parseData) — the first entry is always the hub, everything
// after it is a satellite.
async function drawForceGraphChart(data: ChartData): Promise<FrameNode | null> {
  const entries = parseData(data.data)
  if (!entries.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)
  const barColor = normalizeColor(data.barColor, RED_NORTH)

  const center = entries[0]
  const satellites = entries.slice(1)
  const CENTER_R = 110
  const MIN_SAT_R = 30
  const MAX_SAT_R = 64
  const LABEL_GAP = 22

  const defaultSize = 1000
  const { width: size, height: frameHeight } = resolveFrameSize(data, defaultSize, defaultSize)
  const cx = size / 2, cy = frameHeight / 2

  const frame = figma.createFrame()
  frame.resize(size, frameHeight)
  frame.fills = []
  frame.clipsContent = false
  frame.name = 'Chart'

  const maxSatVal = Math.max(...satellites.map(s => s.value), 1)
  const satR = (v: number) => MIN_SAT_R + (v / maxSatVal) * (MAX_SAT_R - MIN_SAT_R)
  // Leaves room, past the orbit's own outer edge, for the widest satellite plus its label.
  const orbitR = Math.min(size, frameHeight) / 2 - MAX_SAT_R - LABEL_GAP - 140
  const n = Math.max(1, satellites.length)
  const positions = satellites.map((s, i) => {
    const ang = (Math.PI * 2 * i) / n - Math.PI / 2
    return { x: cx + Math.cos(ang) * orbitR, y: cy + Math.sin(ang) * orbitR, ang, r: satR(s.value), label: s.label }
  })

  // Spokes first, so every node sits visually on top of the lines reaching it.
  for (const p of positions) {
    const line = await makeVectorPolyline([{ x: cx, y: cy }, { x: p.x, y: p.y }], theme.grid, 1.5)
    frame.appendChild(line)
  }

  for (const p of positions) {
    const dot = figma.createEllipse()
    dot.resize(p.r * 2, p.r * 2)
    dot.x = p.x - p.r
    dot.y = p.y - p.r
    dot.fills = [solidPaint(theme.bg)]
    dot.strokes = [solidPaint(theme.muted)]
    dot.strokeWeight = 1.5
    frame.appendChild(dot)

    const lbl = await createTextNode(p.label, MODERAT_REGULAR, TICK_LABEL_FONT_SIZE, theme.text)
    const lw = lbl.width || 0, lh = lbl.height || TICK_LABEL_FONT_SIZE
    const cos = Math.cos(p.ang), sin = Math.sin(p.ang)
    // Whichever axis the node sits further along decides which side its label extends
    // toward — always outward, away from the hub, never centered on top of the node itself.
    if (Math.abs(cos) > Math.abs(sin)) {
      lbl.x = Math.round(cos > 0 ? p.x + p.r + LABEL_GAP : p.x - p.r - LABEL_GAP - lw)
      lbl.y = Math.round(p.y - lh / 2)
    } else {
      lbl.x = Math.round(p.x - lw / 2)
      lbl.y = Math.round(sin > 0 ? p.y + p.r + LABEL_GAP : p.y - p.r - LABEL_GAP - lh)
    }
    frame.appendChild(lbl)
  }

  const centerDot = figma.createEllipse()
  centerDot.resize(CENTER_R * 2, CENTER_R * 2)
  centerDot.x = cx - CENTER_R
  centerDot.y = cy - CENTER_R
  centerDot.fills = [solidPaint(barColor)]
  frame.appendChild(centerDot)

  const centerLbl = await createTextNode(center.label, MODERAT_MEDIUM, TICK_LABEL_FONT_SIZE, theme.bg)
  centerLbl.textAlignHorizontal = 'CENTER'
  try { centerLbl.textAutoResize = 'HEIGHT'; centerLbl.resize(Math.max(1, CENTER_R * 1.7), centerLbl.height || TICK_LABEL_FONT_SIZE) } catch { }
  centerLbl.x = Math.round(cx - (centerLbl.width || CENTER_R * 1.7) / 2)
  centerLbl.y = Math.round(cy - (centerLbl.height || TICK_LABEL_FONT_SIZE) / 2)
  frame.appendChild(centerLbl)

  makeUniformScaleAdaptive(frame, size, frameHeight)
  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify('Network chart created')
  return frame
}

// Petal rose (a.k.a. Nightingale/coxcomb chart): every category gets an equal angular
// slice, like a pie, but its RADIUS (not its angle) encodes the value — so the biggest
// numbers visually dominate as the largest petals rather than just the widest wedge.
// Reuses parseData's plain label:value comma format, same as Pie/Donut. The few standout
// values (top 3) render in the brand color; everything else stays muted, mirroring the
// reference's "what actually stood out" reading.
async function drawPetalRoseChart(data: ChartData): Promise<FrameNode | null> {
  const entries = parseData(data.data)
  if (!entries.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)
  const barColor = normalizeColor(data.barColor, RED_NORTH)

  const innerR = 64
  const maxOuterR = 340
  const labelGap = 40
  const half = Math.round(maxOuterR + labelGap + 90)
  const defaultSize = half * 2
  const { width: size, height: frameHeight } = resolveFrameSize(data, defaultSize, defaultSize)
  const cx = size / 2, cy = frameHeight / 2

  const frame = figma.createFrame()
  frame.resize(size, frameHeight)
  frame.fills = []
  frame.clipsContent = false
  frame.name = 'Chart'

  const n = entries.length
  const maxVal = Math.max(...entries.map(e => e.value)) || 1
  const highlightCount = Math.min(3, n)
  const highlightLabels = new Set(
    [...entries].sort((a, b) => b.value - a.value).slice(0, highlightCount).map(e => e.label)
  )
  const anglePer = (Math.PI * 2) / n
  const gap = anglePer * 0.08

  for (let i = 0; i < n; i++) {
    const e = entries[i]
    const startA = -Math.PI / 2 + i * anglePer + gap / 2
    const endA = startA + anglePer - gap
    const outerR = innerR + (maxOuterR - innerR) * (e.value / maxVal)
    const slices = Math.max(4, Math.round(((endA - startA) / (Math.PI * 2)) * 64))
    const outerPts: { x: number; y: number }[] = []
    for (let s = 0; s <= slices; s++) {
      const a = startA + (s / slices) * (endA - startA)
      outerPts.push({ x: cx + Math.cos(a) * outerR, y: cy + Math.sin(a) * outerR })
    }
    const innerPts: { x: number; y: number }[] = []
    for (let s = slices; s >= 0; s--) {
      const a = startA + (s / slices) * (endA - startA)
      innerPts.push({ x: cx + Math.cos(a) * innerR, y: cy + Math.sin(a) * innerR })
    }
    const isHi = highlightLabels.has(e.label)
    const petal = await makeVectorPolygon(outerPts.concat(innerPts), isHi ? barColor : theme.muted)
    petal.name = 'petal'
    frame.appendChild(petal)

    const midA = (startA + endA) / 2
    const labelR = outerR + labelGap
    const lx = cx + Math.cos(midA) * labelR
    const ly = cy + Math.sin(midA) * labelR
    const valTxt = await createValueLabel(e.value, VALUE_FONT_SIZE, isHi ? theme.text : theme.muted)
    valTxt.x = Math.round(lx - (valTxt.width || 0) / 2)
    valTxt.y = Math.round(ly - (valTxt.height || VALUE_FONT_SIZE) - 4)
    frame.appendChild(valTxt)
    const lbl = await createTextNode(e.label, MODERAT_REGULAR, TICK_LABEL_FONT_SIZE - 4, theme.muted)
    lbl.x = Math.round(lx - (lbl.width || 0) / 2)
    lbl.y = Math.round(ly + 6)
    frame.appendChild(lbl)
  }

  const hub = figma.createEllipse()
  hub.resize(innerR, innerR)
  hub.x = cx - innerR / 2
  hub.y = cy - innerR / 2
  hub.fills = [solidPaint(theme.bg)]
  frame.appendChild(hub)

  makeUniformScaleAdaptive(frame, size, frameHeight)
  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify('Petal chart created')
  return frame
}

interface TreeItem { label: string; category: string }

// Tab-separated (Item / Category) per newline-separated row — a category name is free text
// that could carry its own punctuation, so this uses the same safe tab/newline convention as
// Table/KPI rather than the comma-based format everything simpler uses.
function parseTreeItems(str: string): TreeItem[] {
  const out: TreeItem[] = []
  for (const line of String(str || '').split('\n')) {
    if (!line.trim()) continue
    const cells = line.split('\t')
    const label = (cells[0] || '').trim()
    const category = (cells[1] || '').trim()
    if (!label && !category) continue
    out.push({ label, category: category || 'Other' })
  }
  return out
}

// A single flowing S-curve between two points — the connector this chart bundles by the
// dozen or hundred, one per item, all converging on their shared category node. Purely
// horizontal tangents at both ends (regardless of how far apart the two points sit
// vertically) is what gives every line the same gentle "flows out, bends, flows in" shape
// instead of a straight diagonal.
async function makeCurvedConnector(p1: { x: number; y: number }, p2: { x: number; y: number }, stroke: ToolColor, weight = 1.5) {
  const vec = figma.createVector()
  const dx = (p2.x - p1.x) / 2
  const vertices = [{ x: p1.x, y: p1.y }, { x: p2.x, y: p2.y }]
  const segments = [{ start: 0, end: 1, tangentStart: { x: dx, y: 0 }, tangentEnd: { x: -dx, y: 0 } }] as any[]
  await vec.setVectorNetworkAsync({ vertices, segments, regions: [] } as any)
  vec.strokes = [solidPaint(stroke)]
  vec.strokeWeight = weight
  vec.fills = []
  return vec
}

// Tree: every item on the left hands off to exactly one category on the right — many
// thin, quiet items feeding a handful of prominent totals, like an org chart nobody
// explicitly drew but the data reveals anyway. A category's node size and its bundle of
// lines both track its own share (biggest = darkest/largest, using the same
// seriesColorsLight gradient Pie/Donut/Funnel already use for "which slice actually
// dominates"), so which few categories matter reads instantly even across a long, dense
// item list.
async function drawTreeChart(data: ChartData): Promise<FrameNode | null> {
  const items = parseTreeItems(data.data)
  if (!items.length) { figma.notify('No data'); return null }
  await loadFonts()
  const theme = getTheme(data.theme)
  const barColor = normalizeColor(data.barColor, RED_NORTH)

  const counts = new Map<string, number>()
  for (const it of items) counts.set(it.category, (counts.get(it.category) || 0) + 1)
  const categories = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  const colors = seriesColorsLight(barColor, categories.length, theme.bg)
  const catColorOf = new Map<string, ToolColor>()
  categories.forEach((c, i) => catColorOf.set(c.name, colors[i]))

  const ITEM_ROW_H = 40
  const ITEM_FONT = 30
  const MIN_CAT_ROW_H = 80
  const CAT_FONT = 28
  const MIN_R = 10, MAX_R = 30
  const paddingTop = 60, paddingBottom = 60

  const itemsHeight = items.length * ITEM_ROW_H
  const catRowH = Math.max(MIN_CAT_ROW_H, itemsHeight / Math.max(1, categories.length))
  const catsHeight = categories.length * catRowH
  const contentHeight = Math.max(itemsHeight, catsHeight)

  // Column widths are measured from real content (same technique Funnel uses for its label
  // column) so the tick/node columns line up cleanly regardless of how long any name is.
  let maxItemLabelW = 0
  for (const it of items) {
    const w = await measureTextWidth(it.label, MODERAT_REGULAR, ITEM_FONT)
    if (w > maxItemLabelW) maxItemLabelW = w
  }
  const maxCount = Math.max(...categories.map(c => c.count), 1)
  let maxCatLabelW = 0
  for (const c of categories) {
    const w = await measureTextWidth(c.name.toUpperCase() + ' · ' + c.count, MODERAT_MEDIUM, CAT_FONT)
    if (w > maxCatLabelW) maxCatLabelW = w
  }

  const paddingLeft = 40
  const tickW = 26
  const lineStartX = paddingLeft + Math.ceil(maxItemLabelW) + tickW
  const bundleGap = 130
  const lineEndX = lineStartX + bundleGap
  const catLabelGap = 28
  const paddingRight = 40

  // Floored so a handful of placeholder rows never starts this chart out as a tiny sliver —
  // it still grows past this for any dataset that actually needs more room.
  const defaultWidth = Math.max(700, Math.round(lineEndX + MAX_R * 2 + catLabelGap + maxCatLabelW + paddingRight))
  const defaultHeight = Math.max(560, Math.round(paddingTop + contentHeight + paddingBottom))
  const { width: frameWidth, height: frameHeight } = resolveFrameSize(data, defaultWidth, defaultHeight, defaultWidth)

  const frame = figma.createFrame()
  frame.resize(frameWidth, frameHeight)
  frame.fills = []
  frame.clipsContent = false
  frame.name = 'Chart'

  // Items and categories each center within the frame's actual available height — not just
  // the raw content height — so a small dataset centers inside the floored minimum size
  // instead of clinging to the top with dead space stranded below it.
  const availableHeight = frameHeight - paddingTop - paddingBottom
  const itemsTop = paddingTop + (availableHeight - itemsHeight) / 2
  const itemPositions: { x: number; y: number; category: string }[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const y = itemsTop + i * ITEM_ROW_H + ITEM_ROW_H / 2
    const lbl = await createTextNode(it.label, MODERAT_REGULAR, ITEM_FONT, theme.muted)
    lbl.textAlignHorizontal = 'LEFT'
    try { lbl.textAutoResize = 'HEIGHT'; lbl.resize(Math.max(1, maxItemLabelW), lbl.height || ITEM_FONT) } catch { }
    lbl.x = paddingLeft
    lbl.y = Math.round(y - (lbl.height || ITEM_FONT) / 2)
    frame.appendChild(lbl)

    const tick = await makeVectorPolyline([{ x: lineStartX - tickW + 4, y }, { x: lineStartX - 4, y }], theme.grid, 1)
    frame.appendChild(tick)

    itemPositions.push({ x: lineStartX, y, category: it.category })
  }

  const catsTop = paddingTop + (availableHeight - catsHeight) / 2
  const catPositions = new Map<string, { x: number; y: number; r: number }>()
  categories.forEach((c, i) => {
    const y = catsTop + i * catRowH + catRowH / 2
    const r = MIN_R + (c.count / maxCount) * (MAX_R - MIN_R)
    catPositions.set(c.name, { x: lineEndX + MAX_R, y, r })
  })

  // Lines first, so every node sits cleanly on top of the bundle reaching it.
  for (const p of itemPositions) {
    const target = catPositions.get(p.category)
    if (!target) continue
    const line = await makeCurvedConnector(
      { x: p.x, y: p.y }, { x: target.x - target.r, y: target.y },
      catColorOf.get(p.category) || theme.grid, 1.2
    )
    try { line.opacity = 0.45 } catch { }
    frame.appendChild(line)
  }

  for (const c of categories) {
    const pos = catPositions.get(c.name)!
    const dot = figma.createEllipse()
    dot.resize(pos.r * 2, pos.r * 2)
    dot.x = pos.x - pos.r
    dot.y = pos.y - pos.r
    dot.fills = [solidPaint(catColorOf.get(c.name) || barColor)]
    frame.appendChild(dot)

    const lbl = await createTextNode(c.name.toUpperCase() + ' · ' + c.count, MODERAT_MEDIUM, CAT_FONT, theme.text)
    try { lbl.letterSpacing = { value: 4, unit: 'PERCENT' } } catch { }
    lbl.x = Math.round(pos.x + pos.r + catLabelGap)
    lbl.y = Math.round(pos.y - (lbl.height || CAT_FONT) / 2)
    frame.appendChild(lbl)
  }

  makeUniformScaleAdaptive(frame, frameWidth, frameHeight)
  try { frame.setPluginData(TOOL_ID, JSON.stringify(data)) } catch { }
  placeNewChartFrame(frame)
  figma.notify('Tree chart created')
  return frame
}
