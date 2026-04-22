import { BearerAuth } from '../../client/auth.js'

export type CliAuth = BearerAuth

export function resolveAuth(authFlag: string | undefined): CliAuth | undefined {
  if (!authFlag) return undefined
  return new BearerAuth(authFlag)
}
