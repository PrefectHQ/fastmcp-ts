import { FastMCP } from 'fastmcp-ts/server'
import { z } from 'zod'

const server = new FastMCP({ name: 'unit-converter', version: '1.0.0' })

// ── Length ────────────────────────────────────────────────────────────────────

const LengthUnit = z.enum(['m', 'km', 'cm', 'mm', 'ft', 'in', 'mi', 'yd'])
type LengthUnit = z.infer<typeof LengthUnit>

const lengthToMeters: Record<LengthUnit, number> = {
  m: 1,
  km: 1000,
  cm: 0.01,
  mm: 0.001,
  ft: 0.3048,
  in: 0.0254,
  mi: 1609.344,
  yd: 0.9144,
}

server.tool(
  {
    name: 'convert_length',
    description: 'Convert a value between length units (m, km, cm, mm, ft, in, mi, yd).',
    input: z.object({
      value: z.number().describe('The numeric value to convert'),
      from: LengthUnit.describe('Source unit'),
      to: LengthUnit.describe('Target unit'),
    }),
  },
  ({ value, from, to }) => {
    const result = (value * lengthToMeters[from]) / lengthToMeters[to]
    return `${value} ${from} = ${result} ${to}`
  },
)

// ── Weight ────────────────────────────────────────────────────────────────────

const WeightUnit = z.enum(['kg', 'g', 'mg', 'lb', 'oz', 'st'])
type WeightUnit = z.infer<typeof WeightUnit>

const weightToKg: Record<WeightUnit, number> = {
  kg: 1,
  g: 0.001,
  mg: 0.000001,
  lb: 0.453592,
  oz: 0.0283495,
  st: 6.35029,
}

server.tool(
  {
    name: 'convert_weight',
    description: 'Convert a value between weight units (kg, g, mg, lb, oz, st).',
    input: z.object({
      value: z.number().describe('The numeric value to convert'),
      from: WeightUnit.describe('Source unit'),
      to: WeightUnit.describe('Target unit'),
    }),
  },
  ({ value, from, to }) => {
    const result = (value * weightToKg[from]) / weightToKg[to]
    return `${value} ${from} = ${result} ${to}`
  },
)

// ── Temperature ───────────────────────────────────────────────────────────────

const TempUnit = z.enum(['C', 'F', 'K'])
type TempUnit = z.infer<typeof TempUnit>

function convertTemperature(value: number, from: TempUnit, to: TempUnit): number {
  if (from === to) return value
  // Normalise to Celsius first
  let celsius: number
  if (from === 'F') celsius = (value - 32) * (5 / 9)
  else if (from === 'K') celsius = value - 273.15
  else celsius = value
  // Convert from Celsius to target
  if (to === 'F') return celsius * (9 / 5) + 32
  if (to === 'K') return celsius + 273.15
  return celsius
}

server.tool(
  {
    name: 'convert_temperature',
    description: 'Convert a value between temperature units (C, F, K).',
    input: z.object({
      value: z.number().describe('The numeric value to convert'),
      from: TempUnit.describe('Source unit: C (Celsius), F (Fahrenheit), K (Kelvin)'),
      to: TempUnit.describe('Target unit: C (Celsius), F (Fahrenheit), K (Kelvin)'),
    }),
  },
  ({ value, from, to }) => {
    const result = convertTemperature(value, from, to)
    return `${value}°${from} = ${result}°${to}`
  },
)

// ── Start ─────────────────────────────────────────────────────────────────────

server.run()
