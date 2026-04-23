// ---------------------------------------------------------------------------
// Component tree types
// ---------------------------------------------------------------------------

export interface Component {
  type: string
  props?: Record<string, unknown>
  children?: Component[]
}

// If-node carries builder methods but they must be non-enumerable so
// toEqual/JSON.stringify treat the node as a plain object.
export interface IfNode extends Component {
  type: 'if'
  branches: Array<{ condition: string; node: Component }>
  fallback?: Component
  elif(condition: string, node: Component): IfNode
  else(node: Component): Component
}

// ---------------------------------------------------------------------------
// Component catalog — used by GenerativeUI.search_components
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  type: string
  description: string
}

export const COMPONENT_CATALOG: CatalogEntry[] = [
  { type: 'column', description: 'Vertical stack layout. Props: gap, align, padding. Children: any components.' },
  { type: 'row', description: 'Horizontal stack layout. Props: gap, align, justify, wrap. Children: any components.' },
  { type: 'grid', description: 'CSS grid layout. Props: columns, gap. Children: any components.' },
  { type: 'text', description: 'Text display. Props: content (string or Rx), variant (heading|body|caption|code), color.' },
  { type: 'badge', description: 'Status badge. Props: text, color, variant.' },
  { type: 'table', description: 'Data table. Props: columns (string[]), rows (string[][]). No children.' },
  { type: 'chart-bar', description: 'Bar chart. Props: data (object[]), xKey, yKey, title.' },
  { type: 'chart-line', description: 'Line chart. Props: data (object[]), xKey, yKey, title.' },
  { type: 'chart-area', description: 'Area chart. Props: data (object[]), xKey, yKey, title.' },
  { type: 'chart-pie', description: 'Pie chart. Props: data (object[]), labelKey, valueKey, title.' },
  { type: 'input', description: 'Form text input. Props: name, label, type (text|email|number|password), placeholder, required.' },
  { type: 'select', description: 'Dropdown select. Props: name, label, options (string[] or {value,label}[]), required.' },
  { type: 'button', description: 'Clickable button. Props: label, action (tool name string), variant, disabled.' },
  { type: 'if', description: 'Conditional rendering. branches: [{condition, node}], fallback.' },
  { type: 'foreach', description: 'Dynamic list. Props: items (binding expression). Children: [template].' },
  { type: 'rx', description: 'Reactive value. Props: expression (client-side state binding). Embeddable as prop.' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withChildren(type: string, props?: Record<string, unknown>, children?: Component[]): Component {
  const node: Component = { type }
  if (props && Object.keys(props).length > 0) node.props = props
  if (children && children.length > 0) node.children = children
  return node
}

function withProps(type: string, props: Record<string, unknown>): Component {
  return { type, props }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Column(props?: Record<string, unknown>, children?: Component[]): Component {
  return withChildren('column', props, children)
}

export function Row(props?: Record<string, unknown>, children?: Component[]): Component {
  return withChildren('row', props, children)
}

export function Grid(props?: Record<string, unknown>, children?: Component[]): Component {
  return withChildren('grid', props, children)
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

export function Text(content: string | Component, extraProps?: Record<string, unknown>): Component {
  return withProps('text', { content, ...extraProps })
}

export function Badge(text: string, extraProps?: Record<string, unknown>): Component {
  return withProps('badge', { text, ...extraProps })
}

export function Table(props: { columns: string[]; rows: string[][]; [key: string]: unknown }): Component {
  return withProps('table', props as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export function Bar(props: Record<string, unknown>): Component {
  return withProps('chart-bar', props)
}

export function Line(props: Record<string, unknown>): Component {
  return withProps('chart-line', props)
}

export function Area(props: Record<string, unknown>): Component {
  return withProps('chart-area', props)
}

export function Pie(props: Record<string, unknown>): Component {
  return withProps('chart-pie', props)
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export function Input(props: Record<string, unknown>): Component {
  return withProps('input', props)
}

export function Select(props: Record<string, unknown>): Component {
  return withProps('select', props)
}

export function Button(props: Record<string, unknown>): Component {
  return withProps('button', props)
}

// ---------------------------------------------------------------------------
// Control flow — If with non-enumerable builder methods
// ---------------------------------------------------------------------------

function makeIfNode(
  branches: Array<{ condition: string; node: Component }>,
  fallback?: Component,
): IfNode {
  const node = { type: 'if' as const, branches, ...(fallback !== undefined ? { fallback } : {}) } as IfNode

  Object.defineProperty(node, 'elif', {
    enumerable: false,
    value(condition: string, child: Component): IfNode {
      return makeIfNode([...branches, { condition, node: child }], fallback)
    },
  })

  Object.defineProperty(node, 'else', {
    enumerable: false,
    value(child: Component): Component {
      return makeIfNode(branches, child)
    },
  })

  return node
}

export function If(condition: string, then: Component, fallback?: Component): IfNode {
  return makeIfNode([{ condition, node: then }], fallback)
}

// ---------------------------------------------------------------------------
// Dynamic list
// ---------------------------------------------------------------------------

export function ForEach(items: string, template: Component): Component {
  return { type: 'foreach', props: { items }, children: [template] }
}

// ---------------------------------------------------------------------------
// Reactive state binding
// ---------------------------------------------------------------------------

export function Rx(expression: string): Component {
  return withProps('rx', { expression })
}
