import { describe, it, expect, afterEach } from 'vitest'
import { envBool } from '../../src/server/env'

const VAR = 'FASTMCP_TEST_FLAG'

afterEach(() => {
  delete process.env[VAR]
})

describe('envBool', () => {
  it('returns undefined when unset or empty', () => {
    expect(envBool(VAR)).toBeUndefined()
    process.env[VAR] = ''
    expect(envBool(VAR)).toBeUndefined()
  })

  it.each(['1', 'true', 'TRUE', 'True', 'yes', 'on', '  True  '])('reads %s as true', (raw) => {
    process.env[VAR] = raw
    expect(envBool(VAR)).toBe(true)
  })

  it.each(['0', 'false', 'FALSE', 'no', 'off'])('reads %s as false', (raw) => {
    process.env[VAR] = raw
    expect(envBool(VAR)).toBe(false)
  })

  it('throws on a set-but-unrecognised value, naming the variable and the value', () => {
    process.env[VAR] = 'ture'
    expect(() => envBool(VAR)).toThrow(/FASTMCP_TEST_FLAG/)
    expect(() => envBool(VAR)).toThrow(/"ture"/)
  })
})
